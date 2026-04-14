import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { WebsiteService } from './websiteService.js';
import { buildGa4Client, resolveGa4PropertyIdForDomain, type Ga4OrganicLandingPageRow } from './ga4Client.js';

interface PostSlugRow extends RowDataPacket {
  id: string;
  slug: string;
}

/**
 * Detects pages with poor organic engagement in GA4 and queues a manual refresh.
 * This makes rewrites autonomous even before GSC has enough signal.
 *
 * Strategy:
 * - Look at Organic Search landing pages (last 90 days)
 * - If bounceRate is high and engagement is low, queue full_refresh
 * - Map landingPage path -> posts.slug (last path segment)
 * - Insert into content_refresh_queue as trigger_type='manual' with GA4 context JSON
 */
export class Ga4EngagementRefreshDetector {
  constructor(private readonly pool: MysqlPool) {}

  async detectAndQueueAll(args?: {
    daysBack?: number;
    maxPerWebsite?: number;
    minSessions?: number;
    minBounceRate?: number;
    maxAvgEngagementSec?: number;
  }): Promise<Array<{ websiteId: string; queued: number; skipped: string }>> {
    const websiteService = new WebsiteService(this.pool);
    const websites = await websiteService.getActiveWebsites();

    const results: Array<{ websiteId: string; queued: number; skipped: string }> = [];

    for (const site of websites) {
      const ga4PropertyId =
        (site.ga4PropertyId && site.ga4PropertyId.trim()) ? site.ga4PropertyId.trim() : resolveGa4PropertyIdForDomain(site.domain);

      if (!ga4PropertyId) {
        results.push({ websiteId: site.id, queued: 0, skipped: 'no_ga4_property_id' });
        continue;
      }

      const ga4 = buildGa4Client(ga4PropertyId);
      if (!ga4) {
        results.push({ websiteId: site.id, queued: 0, skipped: 'ga4_client_not_configured' });
        continue;
      }

      try {
        const landingPages = await ga4.getTopLandingPages({ daysBack: args?.daysBack ?? 90 });
        const queued = await this.queueFromLandingPages(site.id, landingPages, {
          maxPerWebsite: args?.maxPerWebsite ?? 3,
          minSessions: args?.minSessions ?? 20,
          minBounceRate: args?.minBounceRate ?? 0.75,
          maxAvgEngagementSec: args?.maxAvgEngagementSec ?? 30,
        });
        results.push({ websiteId: site.id, queued, skipped: '' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as any)?.code ?? (err as any)?.status;
        const detail = `${status ? `${status}` : 'err'}:${msg}`.slice(0, 180);
        results.push({ websiteId: site.id, queued: 0, skipped: `ga4_query_failed:${detail}` });
      }
    }

    return results;
  }

  private async queueFromLandingPages(
    websiteId: string,
    landingPages: Ga4OrganicLandingPageRow[],
    thresholds: { maxPerWebsite: number; minSessions: number; minBounceRate: number; maxAvgEngagementSec: number }
  ): Promise<number> {
    // Candidate pages: enough sessions, high bounce, low engagement.
    const candidates = landingPages
      .filter((p) => p.sessions >= thresholds.minSessions)
      .filter((p) => p.bounceRate >= thresholds.minBounceRate)
      .filter((p) => p.avgEngagementSec <= thresholds.maxAvgEngagementSec)
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, thresholds.maxPerWebsite * 5); // allow some misses during slug mapping

    if (candidates.length === 0) return 0;

    // Load post slugs for this website for quick mapping.
    const [postRows] = await this.pool.query<PostSlugRow[]>(
      `SELECT id, slug FROM posts WHERE website_id = ? AND slug IS NOT NULL`,
      [websiteId]
    );
    const slugToPostId = new Map(postRows.map((r) => [String(r.slug).toLowerCase(), String(r.id)] as const));

    let queued = 0;
    for (const page of candidates) {
      if (queued >= thresholds.maxPerWebsite) break;

      const slug = extractSlugFromPath(page.page);
      if (!slug) continue;
      const postId = slugToPostId.get(slug.toLowerCase());
      if (!postId) continue;

      // Don't double-queue
      const [existing] = await this.pool.query<RowDataPacket[]>(
        `SELECT id FROM content_refresh_queue
         WHERE post_id = ? AND status IN ('queued', 'processing')
         LIMIT 1`,
        [postId]
      );
      if (existing.length > 0) continue;

      const id = crypto.randomUUID();
      const ctx = {
        ga4: {
          sessions: page.sessions,
          bounceRate: page.bounceRate,
          avgEngagementSec: page.avgEngagementSec,
          landingPage: page.page,
          reason: 'High bounce + low engagement on Organic Search landing page',
        },
      };

      await this.pool.query<ResultSetHeader>(
        `INSERT INTO content_refresh_queue (id, post_id, website_id, refresh_type, trigger_type, gsc_context_json)
         VALUES (?, ?, ?, 'full_refresh', 'manual', ?)`,
        [id, postId, websiteId, JSON.stringify(ctx)]
      );
      queued++;
    }

    return queued;
  }
}

function extractSlugFromPath(pathOrUrl: string): string | null {
  if (!pathOrUrl) return null;
  let path = pathOrUrl;
  try {
    if (pathOrUrl.startsWith('http')) path = new URL(pathOrUrl).pathname;
  } catch {
    // ignore
  }
  const clean = path.split('?')[0]?.split('#')[0] ?? path;
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1] ?? null;
}

