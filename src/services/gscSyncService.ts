import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { env } from '../config/env.js';
import { buildGscClient } from './gscClient.js';

interface WebsiteRow extends RowDataPacket {
  id: string;
  domain: string;
  gsc_property_uri: string | null;
}

interface PostSlugRow extends RowDataPacket {
  id: string;
  slug: string;
  website_id: string;
}

export interface GscSyncResult {
  siteDomain: string;
  rowsUpserted: number;
  pageMetricsUpserted: number;
  error?: string;
}

/**
 * Pulls GSC performance data for all configured websites and stores it in
 * gsc_performance (raw fact table) and gsc_page_metrics (aggregated rollup).
 *
 * Uses a single OAuth2 client for all properties — the authenticated user
 * must have access to both sc-domain:primestrides.com and sc-domain:theabdulrehman.com.
 *
 * Designed to run daily at 6 AM, before the 9:15 AM content pipeline.
 */
export class GscSyncService {
  constructor(private readonly pool: MysqlPool) {}

  /**
   * Sync all active websites that have a GSC property URI configured.
   */
  async syncAll(): Promise<GscSyncResult[]> {
    const client = buildGscClient();
    if (!client) {
      console.log('[GscSync] OAuth2 credentials not configured — skipping');
      return [];
    }

    const [websites] = await this.pool.query<WebsiteRow[]>(
      `SELECT id, domain, gsc_property_uri
       FROM websites
       WHERE is_active = 1
         AND gsc_property_uri IS NOT NULL`
    );

    if (websites.length === 0) {
      console.log('[GscSync] No websites with gsc_property_uri configured');
      return [];
    }

    const results: GscSyncResult[] = [];
    for (const site of websites) {
      const result = await this.syncWebsite(client, site);
      results.push(result);
    }
    return results;
  }

  private async syncWebsite(
    client: InstanceType<typeof import('./gscClient.js').GscClient>,
    site: WebsiteRow
  ): Promise<GscSyncResult> {
    if (!site.gsc_property_uri) {
      return { siteDomain: site.domain, rowsUpserted: 0, pageMetricsUpserted: 0 };
    }

    try {
      const rowsUpserted = await this.syncPerformanceData(client, site);
      const pageMetricsUpserted = await this.syncPageMetrics(client, site);
      return { siteDomain: site.domain, rowsUpserted, pageMetricsUpserted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GscSync] Error syncing ${site.domain}:`, message);
      return { siteDomain: site.domain, rowsUpserted: 0, pageMetricsUpserted: 0, error: message };
    }
  }

  /**
   * Pull page+query performance for the last N days and upsert into gsc_performance.
   */
  private async syncPerformanceData(
    client: InstanceType<typeof import('./gscClient.js').GscClient>,
    site: WebsiteRow
  ): Promise<number> {
    const { startDate, endDate } = this.getDateRange(env.GSC_SYNC_DAYS_BACK);

    const rows = await client.queryPerformance({
      siteUrl: site.gsc_property_uri!,
      startDate,
      endDate,
      dimensions: ['page', 'query', 'date'],
      rowLimit: 25000,
    });

    if (rows.length === 0) return 0;

    let upserted = 0;
    for (const row of rows) {
      if (!row.page || !row.query || !row.date) continue;

      const id = crypto.randomUUID();
      const [res] = await this.pool.query<ResultSetHeader>(
        `INSERT INTO gsc_performance (id, website_id, page_url, query, date, clicks, impressions, ctr, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           clicks = VALUES(clicks),
           impressions = VALUES(impressions),
           ctr = VALUES(ctr),
           position = VALUES(position),
           synced_at = CURRENT_TIMESTAMP`,
        [id, site.id, row.page, row.query, row.date, row.clicks, row.impressions, row.ctr, row.position]
      );
      upserted += res.affectedRows ?? 0;
    }

    return upserted;
  }

  /**
   * Build aggregated page metrics for two windows (recent 7 days and prior 21 days)
   * and upsert into gsc_page_metrics, linking post_id via slug matching.
   */
  private async syncPageMetrics(
    client: InstanceType<typeof import('./gscClient.js').GscClient>,
    site: WebsiteRow
  ): Promise<number> {
    // Load post slugs for this website to resolve page_url → post_id
    const [postRows] = await this.pool.query<PostSlugRow[]>(
      `SELECT id, slug, website_id FROM posts WHERE website_id = ?`,
      [site.id]
    );
    const slugToPostId = new Map<string, string>();
    for (const p of postRows) {
      if (p.slug) slugToPostId.set(p.slug.toLowerCase(), p.id);
    }

    const today = new Date();
    const windows = [
      // Recent 7 days
      {
        start: this.formatDate(new Date(today.getTime() - 7 * 86400000)),
        end: this.formatDate(today),
      },
      // Prior 21 days (days 8–28)
      {
        start: this.formatDate(new Date(today.getTime() - 28 * 86400000)),
        end: this.formatDate(new Date(today.getTime() - 8 * 86400000)),
      },
    ];

    let totalUpserted = 0;

    for (const window of windows) {
      const rows = await client.queryPerformance({
        siteUrl: site.gsc_property_uri!,
        startDate: window.start,
        endDate: window.end,
        dimensions: ['page'],
        rowLimit: 5000,
      });

      // Aggregate by page
      const byPage = new Map<string, { clicks: number; impr: number; ctrSum: number; posSum: number; count: number }>();
      for (const row of rows) {
        if (!row.page) continue;
        const existing = byPage.get(row.page) ?? { clicks: 0, impr: 0, ctrSum: 0, posSum: 0, count: 0 };
        existing.clicks += row.clicks;
        existing.impr += row.impressions;
        existing.ctrSum += row.ctr;
        existing.posSum += row.position;
        existing.count += 1;
        byPage.set(row.page, existing);
      }

      for (const [pageUrl, agg] of byPage.entries()) {
        const postId = this.resolvePostId(pageUrl, slugToPostId);
        const avgCtr = agg.count > 0 ? agg.ctrSum / agg.count : 0;
        const avgPosition = agg.count > 0 ? agg.posSum / agg.count : 0;

        const id = crypto.randomUUID();
        const [res] = await this.pool.query<ResultSetHeader>(
          `INSERT INTO gsc_page_metrics
             (id, website_id, page_url, post_id, period_start, period_end, total_clicks, total_impr, avg_ctr, avg_position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             post_id = VALUES(post_id),
             total_clicks = VALUES(total_clicks),
             total_impr = VALUES(total_impr),
             avg_ctr = VALUES(avg_ctr),
             avg_position = VALUES(avg_position),
             synced_at = CURRENT_TIMESTAMP`,
          [id, site.id, pageUrl, postId, window.start, window.end, agg.clicks, agg.impr, avgCtr, avgPosition]
        );
        totalUpserted += res.affectedRows ?? 0;
      }
    }

    return totalUpserted;
  }

  /**
   * Resolve a GSC page URL to a posts.id by extracting the slug and matching
   * against the slugToPostId map.
   *
   * e.g. "https://primestrides.com/blog/hire-remote-devs" → slug "hire-remote-devs"
   */
  private resolvePostId(pageUrl: string, slugToPostId: Map<string, string>): string | null {
    try {
      const url = new URL(pageUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        const candidate = parts[i]!.toLowerCase();
        const postId = slugToPostId.get(candidate);
        if (postId) return postId;
      }
    } catch {
      // Ignore invalid URLs
    }
    return null;
  }

  private getDateRange(daysBack: number): { startDate: string; endDate: string } {
    const end = new Date();
    const start = new Date(end.getTime() - daysBack * 86400000);
    return { startDate: this.formatDate(start), endDate: this.formatDate(end) };
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0]!;
  }
}
