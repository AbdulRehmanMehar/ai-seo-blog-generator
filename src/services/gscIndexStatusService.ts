import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { buildGscClient, type GscClient } from './gscClient.js';
import { buildPostUrl } from './sitemapService.js';
import { sleep } from '../utils/sleep.js';

export type IndexState =
  | 'indexed'
  | 'discovered_not_indexed'
  | 'crawled_not_indexed'
  | 'unknown'
  | 'excluded'
  | 'error';

export interface IndexScanResult {
  scanned: number;
  byState: Record<string, number>;
}

interface WebsiteRow extends RowDataPacket {
  id: string;
  domain: string;
  gsc_property_uri: string | null;
}

interface PostRow extends RowDataPacket {
  id: string;
  slug: string;
  website_id: string;
}

/**
 * Normalize the URL Inspection API's coverageState into a small action-routable enum.
 * The raw strings vary ("Submitted and indexed", "Discovered - currently not indexed",
 * "URL is unknown to Google", "Excluded by 'noindex' tag", ...).
 */
export function normalizeIndexState(coverageState: string | undefined, verdict: string | undefined): IndexState {
  const s = (coverageState ?? '').toLowerCase();
  if (s.includes('indexed') && !s.includes('not indexed')) return 'indexed';
  if (s.includes('discovered') && s.includes('not indexed')) return 'discovered_not_indexed';
  if (s.includes('crawled') && s.includes('not indexed')) return 'crawled_not_indexed';
  if (s.includes('unknown to google')) return 'unknown';
  if (s.includes('excluded') || s.includes('canonical') || s.includes('redirect') || s.includes('noindex') || s.includes('duplicate')) {
    return 'excluded';
  }
  // Fall back to the verdict when coverageState is empty/unrecognized.
  if ((verdict ?? '').toUpperCase() === 'PASS') return 'indexed';
  return 'unknown';
}

/**
 * Scans published posts against the Google URL Inspection API and stores each post's
 * index state. Rotating: the posts with the oldest (or null) index_checked_at are scanned
 * first, so repeated runs cycle through the whole library and keep states fresh.
 */
export class GscIndexStatusService {
  constructor(private readonly pool: MysqlPool) {}

  /** Scan up to `limit` published posts, oldest-checked first. Best-effort per post. */
  async scanBatch(opts: { limit: number; delayMs?: number }): Promise<IndexScanResult> {
    const client = buildGscClient();
    if (!client) {
      // eslint-disable-next-line no-console
      console.log('[GscIndexStatus] No GSC auth configured — skipping scan');
      return { scanned: 0, byState: {} };
    }

    const [websiteRows] = await this.pool.query<WebsiteRow[]>(
      `SELECT id, domain, gsc_property_uri FROM websites WHERE gsc_property_uri IS NOT NULL`
    );
    const websites = new Map(
      (websiteRows as WebsiteRow[]).map((w) => [w.id, { domain: w.domain, property: w.gsc_property_uri! }])
    );
    if (websites.size === 0) return { scanned: 0, byState: {} };

    const [postRows] = await this.pool.query<PostRow[]>(
      `SELECT id, slug, website_id FROM posts
        WHERE status = 'published' AND slug IS NOT NULL AND website_id IS NOT NULL
        ORDER BY index_checked_at IS NULL DESC, index_checked_at ASC
        LIMIT ?`,
      [opts.limit]
    );

    const delayMs = opts.delayMs ?? 800;
    const byState: Record<string, number> = {};
    let scanned = 0;

    for (const post of postRows as PostRow[]) {
      const site = websites.get(post.website_id);
      if (!site) continue;
      const url = buildPostUrl(site.domain, post.slug);

      let state: IndexState;
      let rawCoverage: string | null = null;
      try {
        const r = await client.inspectUrl(site.property, url);
        state = normalizeIndexState(r.coverageState, r.indexingState);
        rawCoverage = r.coverageState ?? r.indexingState ?? null;
      } catch (err) {
        state = 'error';
        rawCoverage = err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150);
      }

      await this.pool.query<ResultSetHeader>(
        `UPDATE posts SET index_state = ?, index_coverage_state = ?, index_checked_at = NOW() WHERE id = ?`,
        [state, rawCoverage, post.id]
      );
      byState[state] = (byState[state] ?? 0) + 1;
      scanned += 1;
      if (delayMs > 0) await sleep(delayMs);
    }

    return { scanned, byState };
  }

  /** Index-state breakdown per website (from the last scan results stored on posts). */
  async getSummary(): Promise<Array<{ domain: string; state: string; count: number }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT w.domain, COALESCE(p.index_state, 'unscanned') AS state, COUNT(*) AS count
         FROM posts p
         JOIN websites w ON w.id = p.website_id
        WHERE p.status = 'published'
        GROUP BY w.domain, COALESCE(p.index_state, 'unscanned')
        ORDER BY w.domain, count DESC`
    );
    return (rows as any[]).map((r) => ({ domain: String(r.domain), state: String(r.state), count: Number(r.count) }));
  }
}

// Re-export the type so callers can import the GscClient type alongside.
export type { GscClient };
