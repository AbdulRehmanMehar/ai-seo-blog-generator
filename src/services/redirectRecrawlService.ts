import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import { buildPostUrl } from './sitemapService.js';
import type { PublishedPostUrl } from './sitemapService.js';

/**
 * Finds consolidated (status='merged') posts whose OLD url still sits in a
 * not-indexed state in Search Console, so Google can be asked to re-crawl it and
 * discover the 301 — moving the URL from "Crawled - currently not indexed" into
 * "Page with redirect".
 *
 * Nothing else in the pipeline reaches these URLs:
 *   - the sitemap deliberately excludes redirected URLs, so a sitemap ping misses them
 *   - getRecentlyPublishedUrls() only returns status='published' rows
 * After a consolidation run the redirected URLs are typically the single largest
 * block of "crawled - not indexed" in the Page Indexing report, and until now
 * nothing prompted a re-crawl of them.
 *
 * A URL is only ever returned once its redirect is ACTUALLY LIVE. That is a
 * quota-correctness requirement, not a nicety: GoogleIndexingService records every
 * ping in the google_indexing_pings ledger and only re-pings a URL whose lastmod is
 * strictly later than the last ping date. Pinging before the site serves the 3xx
 * would waste quota AND write a ledger row that blocks the later, useful ping.
 */
export class RedirectRecrawlService {
  /** Statuses worth re-crawling. 'excluded' means Google already sees the redirect. */
  private static readonly STALE_STATES = ['crawled_not_indexed', 'discovered_not_indexed', 'unknown'];
  private static readonly REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

  constructor(private readonly pool: MysqlPool) {}

  /**
   * Candidate old-URLs, most-stale first. `limit` bounds the DB read; the caller
   * still filters these down to the ones actually serving a redirect.
   */
  async findCandidates(limit: number): Promise<PublishedPostUrl[]> {
    const placeholders = RedirectRecrawlService.STALE_STATES.map(() => '?').join(',');
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.slug, p.updated_at, w.id AS website_id, w.domain
         FROM posts p
         JOIN websites w ON w.id = p.website_id
        WHERE p.status = 'merged'
          AND p.redirect_to_slug IS NOT NULL
          AND w.gsc_property_uri IS NOT NULL
          AND (p.index_state IN (${placeholders}) OR p.index_state IS NULL)
        ORDER BY FIELD(p.index_state, ${placeholders}) ASC, p.updated_at DESC
        LIMIT ?`,
      [...RedirectRecrawlService.STALE_STATES, ...RedirectRecrawlService.STALE_STATES, limit]
    );
    return (rows as any[]).map((r) => ({
      websiteId: String(r.website_id),
      domain: String(r.domain),
      slug: String(r.slug),
      url: buildPostUrl(String(r.domain), String(r.slug)),
      lastmod: new Date(r.updated_at).toISOString().slice(0, 10),
    }));
  }

  /** True when the URL currently answers with a redirect status. Never throws. */
  private async isRedirecting(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual' });
      return RedirectRecrawlService.REDIRECT_CODES.has(res.status);
    } catch {
      return false; // network failure — treat as not-live and skip
    }
  }

  /**
   * Filter candidates down to `want` URLs that are genuinely redirecting, checking
   * in small concurrent waves and stopping as soon as enough are found — so a large
   * backlog does not mean hundreds of HTTP checks on every pipeline run.
   */
  async takeLive(candidates: PublishedPostUrl[], want: number, concurrency = 6): Promise<PublishedPostUrl[]> {
    const live: PublishedPostUrl[] = [];
    for (let i = 0; i < candidates.length && live.length < want; i += concurrency) {
      const wave = candidates.slice(i, i + concurrency);
      const checks = await Promise.all(wave.map(async (c) => ({ c, ok: await this.isRedirecting(c.url) })));
      for (const { c, ok } of checks) {
        if (ok && live.length < want) live.push(c);
      }
    }
    return live;
  }

  /** Convenience: candidates -> live batch, sized to `want`. */
  async findLiveBatch(want: number, scanMultiplier = 4): Promise<PublishedPostUrl[]> {
    if (want <= 0) return [];
    const candidates = await this.findCandidates(want * scanMultiplier);
    return this.takeLive(candidates, want);
  }
}
