import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { env } from '../config/env.js';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface CtrOpportunity {
  postId: string | null;
  pageUrl: string;
  impressions: number;
  ctr: number;
  avgPosition: number;
  topQueries: string[];
}

export interface NearMissKeyword {
  query: string;
  pageUrl: string;
  avgPosition: number;
  impressions: number;
  clicks: number;
  existingPostId: string | null;
}

export interface DecliningPost {
  postId: string;
  pageUrl: string;
  positionChange: number;   // positive = worsened (higher number = lower rank)
  clickDelta: number;       // negative = lost clicks
  baselinePosition: number;
  currentPosition: number;
}

export interface OpportunityDetectionResult {
  websiteId: string;
  lowCtr: number;
  nearMiss: number;
  declining: number;
}

// ─── DB row shapes ─────────────────────────────────────────────────────────────

interface PageMetricRow extends RowDataPacket {
  website_id: string;
  page_url: string;
  post_id: string | null;
  period_start: string;
  period_end: string;
  total_clicks: number;
  total_impr: number;
  avg_ctr: number;
  avg_position: number;
}

interface TopQueryRow extends RowDataPacket {
  query: string;
  impressions: number;
}

interface WebsiteRow extends RowDataPacket {
  id: string;
  domain: string;
  gsc_property_uri: string | null;
}

/**
 * Reads from gsc_performance and gsc_page_metrics to identify three types of
 * content opportunities and writes them to gsc_opportunities.
 *
 * This service has NO external API calls — it only reads stored GSC data.
 */
export class GscOpportunityDetector {
  constructor(private readonly pool: MysqlPool) {}

  /**
   * Run all three detectors for all GSC-configured websites.
   */
  async detectAll(): Promise<OpportunityDetectionResult[]> {
    const [websites] = await this.pool.query<WebsiteRow[]>(
      `SELECT id, domain, gsc_property_uri
       FROM websites
       WHERE is_active = 1
         AND gsc_property_uri IS NOT NULL`
    );

    const results: OpportunityDetectionResult[] = [];
    for (const site of websites) {
      const result = await this.detectForWebsite(site.id);
      results.push(result);
    }
    return results;
  }

  async detectForWebsite(websiteId: string): Promise<OpportunityDetectionResult> {
    const [lowCtrOpps, nearMissKws, decliningPosts] = await Promise.all([
      this.detectLowCtrOpportunities(websiteId),
      this.detectNearMissKeywords(websiteId),
      this.detectDecliningContent(websiteId),
    ]);

    const lowCtr = await this.writeOpportunities(websiteId, 'low_ctr', lowCtrOpps);
    const nearMiss = await this.writeNearMissOpportunities(websiteId, nearMissKws);
    const declining = await this.writeDecliningOpportunities(websiteId, decliningPosts);

    return { websiteId, lowCtr, nearMiss, declining };
  }

  // ─── Detector: Low CTR ────────────────────────────────────────────────────

  /**
   * Pages with high impressions but CTR below the configured threshold.
   * These have a title/meta problem — people see them but don't click.
   */
  async detectLowCtrOpportunities(websiteId: string): Promise<CtrOpportunity[]> {
    const { startDate, endDate } = this.getRecentWindow(28);

    // Get aggregate CTR per page over last 28 days
    const [pages] = await this.pool.query<PageMetricRow[]>(
      `SELECT pm.page_url, pm.post_id, pm.total_impr, pm.avg_ctr, pm.avg_position
       FROM gsc_page_metrics pm
       WHERE pm.website_id = ?
         AND pm.period_start >= ?
         AND pm.period_end <= ?
         AND pm.total_impr >= ?
         AND pm.avg_ctr < ?
         AND pm.avg_position <= 20
       ORDER BY pm.total_impr DESC
       LIMIT 20`,
      [websiteId, startDate, endDate, env.GSC_IMPRESSION_MIN, env.GSC_CTR_THRESHOLD]
    );

    const opportunities: CtrOpportunity[] = [];

    for (const page of pages) {
      // Get the top queries driving impressions to this page
      const [queryRows] = await this.pool.query<TopQueryRow[]>(
        `SELECT query, SUM(impressions) as impressions
         FROM gsc_performance
         WHERE website_id = ?
           AND page_url = ?
           AND date >= ?
         GROUP BY query
         ORDER BY impressions DESC
         LIMIT 5`,
        [websiteId, page.page_url, startDate]
      );

      opportunities.push({
        postId: page.post_id ?? null,
        pageUrl: page.page_url,
        impressions: page.total_impr,
        ctr: Number(page.avg_ctr),
        avgPosition: Number(page.avg_position),
        topQueries: queryRows.map(r => r.query),
      });
    }

    return opportunities;
  }

  // ─── Detector: Near Miss Keywords ─────────────────────────────────────────

  /**
   * Queries where the site ranks position 5–20 with no dedicated post.
   * These are proven-demand keywords that just need a focused post.
   */
  async detectNearMissKeywords(websiteId: string): Promise<NearMissKeyword[]> {
    const { startDate } = this.getRecentWindow(28);

    // Aggregate per query: avg position and total impressions over last 28 days
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
         gp.query,
         gp.page_url,
         AVG(gp.position) as avg_position,
         SUM(gp.impressions) as impressions,
         SUM(gp.clicks) as clicks,
         pm.post_id
       FROM gsc_performance gp
       LEFT JOIN gsc_page_metrics pm
         ON pm.website_id = gp.website_id
        AND pm.page_url = gp.page_url
        AND pm.period_start >= ?
       WHERE gp.website_id = ?
         AND gp.date >= ?
         AND gp.impressions > 0
       GROUP BY gp.query, gp.page_url, pm.post_id
       HAVING avg_position >= ?
          AND avg_position <= ?
          AND impressions >= 50
       ORDER BY impressions DESC
       LIMIT 30`,
      [startDate, websiteId, startDate, env.GSC_NEAR_MISS_MIN_POSITION, env.GSC_NEAR_MISS_MAX_POSITION]
    );

    return (rows as Array<{
      query: string;
      page_url: string;
      avg_position: number;
      impressions: number;
      clicks: number;
      post_id: string | null;
    }>).map(row => ({
      query: row.query,
      pageUrl: row.page_url,
      avgPosition: Number(row.avg_position),
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      existingPostId: row.post_id ?? null,
    }));
  }

  // ─── Detector: Declining Content ──────────────────────────────────────────

  /**
   * Posts whose average position worsened by more than the configured delta
   * AND whose clicks dropped by more than 20% comparing last 7 days vs prior 21 days.
   */
  async detectDecliningContent(websiteId: string): Promise<DecliningPost[]> {
    const today = new Date();
    const recentStart = this.formatDate(new Date(today.getTime() - 7 * 86400000));
    const recentEnd = this.formatDate(today);
    const baselineStart = this.formatDate(new Date(today.getTime() - 28 * 86400000));
    const baselineEnd = this.formatDate(new Date(today.getTime() - 8 * 86400000));

    // Recent window metrics
    const [recentRows] = await this.pool.query<PageMetricRow[]>(
      `SELECT page_url, post_id, total_clicks, total_impr, avg_position
       FROM gsc_page_metrics
       WHERE website_id = ?
         AND period_start >= ?
         AND period_end <= ?
         AND total_impr >= 50
         AND post_id IS NOT NULL`,
      [websiteId, recentStart, recentEnd]
    );

    if (recentRows.length === 0) return [];

    // Baseline window metrics (prior 21 days)
    const [baselineRows] = await this.pool.query<PageMetricRow[]>(
      `SELECT page_url, total_clicks, avg_position
       FROM gsc_page_metrics
       WHERE website_id = ?
         AND period_start >= ?
         AND period_end <= ?`,
      [websiteId, baselineStart, baselineEnd]
    );

    const baselineMap = new Map(baselineRows.map(r => [r.page_url, r]));

    const declining: DecliningPost[] = [];

    for (const recent of recentRows) {
      const baseline = baselineMap.get(recent.page_url);
      if (!baseline) continue;

      const positionChange = Number(recent.avg_position) - Number(baseline.avg_position);
      const clickDelta = recent.total_clicks - baseline.total_clicks;
      const clickDropPct = baseline.total_clicks > 0
        ? (clickDelta / baseline.total_clicks)
        : 0;

      // Only flag if position worsened AND clicks dropped meaningfully
      if (positionChange >= env.GSC_DECLINE_POSITION_DELTA && clickDropPct <= -0.20) {
        declining.push({
          postId: recent.post_id!,
          pageUrl: recent.page_url,
          positionChange,
          clickDelta,
          baselinePosition: Number(baseline.avg_position),
          currentPosition: Number(recent.avg_position),
        });
      }
    }

    return declining;
  }

  // ─── Opportunity writers ───────────────────────────────────────────────────

  private async writeOpportunities(
    websiteId: string,
    type: 'low_ctr',
    items: CtrOpportunity[]
  ): Promise<number> {
    let written = 0;
    for (const item of items) {
      // Skip if a pending/in_progress opportunity for this page+type already exists
      const [existing] = await this.pool.query<RowDataPacket[]>(
        `SELECT id FROM gsc_opportunities
         WHERE website_id = ? AND opportunity_type = ? AND page_url = ?
           AND status IN ('pending', 'in_progress')
         LIMIT 1`,
        [websiteId, type, item.pageUrl]
      );
      if ((existing as RowDataPacket[]).length > 0) continue;

      const id = crypto.randomUUID();
      const metrics = {
        impressions: item.impressions,
        ctr: item.ctr,
        avgPosition: item.avgPosition,
        topQueries: item.topQueries,
      };
      // Priority: more impressions → higher priority (lower number)
      const priority = Math.max(1, Math.min(10, Math.round(10 - (item.impressions / 100))));

      await this.pool.query<ResultSetHeader>(
        `INSERT INTO gsc_opportunities
           (id, website_id, opportunity_type, post_id, page_url, metrics_json, status, priority)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [id, websiteId, type, item.postId, item.pageUrl, JSON.stringify(metrics), priority]
      );
      written++;
    }
    return written;
  }

  private async writeNearMissOpportunities(
    websiteId: string,
    items: NearMissKeyword[]
  ): Promise<number> {
    let written = 0;
    for (const item of items) {
      const [existing] = await this.pool.query<RowDataPacket[]>(
        `SELECT id FROM gsc_opportunities
         WHERE website_id = ? AND opportunity_type = 'near_miss' AND query = ?
           AND status IN ('pending', 'in_progress')
         LIMIT 1`,
        [websiteId, item.query]
      );
      if ((existing as RowDataPacket[]).length > 0) continue;

      const id = crypto.randomUUID();
      const metrics = {
        avgPosition: item.avgPosition,
        impressions: item.impressions,
        clicks: item.clicks,
        pageUrl: item.pageUrl,
      };
      const priority = Math.max(1, Math.min(10, Math.round(10 - (item.impressions / 50))));

      await this.pool.query<ResultSetHeader>(
        `INSERT INTO gsc_opportunities
           (id, website_id, opportunity_type, post_id, page_url, query, metrics_json, status, priority)
         VALUES (?, ?, 'near_miss', ?, ?, ?, ?, 'pending', ?)`,
        [id, websiteId, item.existingPostId, item.pageUrl, item.query, JSON.stringify(metrics), priority]
      );
      written++;
    }
    return written;
  }

  private async writeDecliningOpportunities(
    websiteId: string,
    items: DecliningPost[]
  ): Promise<number> {
    let written = 0;
    for (const item of items) {
      const [existing] = await this.pool.query<RowDataPacket[]>(
        `SELECT id FROM gsc_opportunities
         WHERE website_id = ? AND opportunity_type = 'declining' AND post_id = ?
           AND status IN ('pending', 'in_progress')
         LIMIT 1`,
        [websiteId, item.postId]
      );
      if ((existing as RowDataPacket[]).length > 0) continue;

      const id = crypto.randomUUID();
      const metrics = {
        positionChange: item.positionChange,
        clickDelta: item.clickDelta,
        baselinePosition: item.baselinePosition,
        currentPosition: item.currentPosition,
      };

      await this.pool.query<ResultSetHeader>(
        `INSERT INTO gsc_opportunities
           (id, website_id, opportunity_type, post_id, page_url, metrics_json, status, priority)
         VALUES (?, ?, 'declining', ?, ?, ?, 'pending', 3)`,
        [id, websiteId, item.postId, item.pageUrl, JSON.stringify(metrics)]
      );
      written++;
    }
    return written;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getRecentWindow(daysBack: number): { startDate: string; endDate: string } {
    const end = new Date();
    const start = new Date(end.getTime() - daysBack * 86400000);
    return { startDate: this.formatDate(start), endDate: this.formatDate(end) };
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0]!;
  }
}
