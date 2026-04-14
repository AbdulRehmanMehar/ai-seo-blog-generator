import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';

interface TopPageRow extends RowDataPacket {
  page_url: string;
  post_id: string | null;
  avg_position: number;
  total_impr: number;
  avg_ctr: number;
}

interface NearMissRow extends RowDataPacket {
  query: string;
  metrics_json: string;
  post_id: string | null;
}

interface TopQueryForKeywordRow extends RowDataPacket {
  query: string;
  impressions: number;
  avg_position: number;
}

export interface GscKeywordContext {
  /** Queries already driving impressions to any page on the site */
  relatedQueries: Array<{ query: string; impressions: number; avgPosition: number }>;
  /** Is any existing page already ranking for something close? */
  existingCoverage: boolean;
}

/**
 * Builds GSC-derived context strings that are injected into Gemini prompts.
 * Reads from DB only — no API calls.
 */
export class GscFeedbackAggregator {
  constructor(private readonly pool: MysqlPool) {}

  /**
   * Build a multi-line GSC insights block for the topic planning prompt.
   * Shows what's working, what's near-miss, and what Google is rewarding.
   */
  async buildGscPromptContext(websiteId: string): Promise<string> {
    const [topPages, nearMissOpps] = await Promise.all([
      this.getTopPerformingPages(websiteId),
      this.getPendingNearMissOpportunities(websiteId),
    ]);

    if (topPages.length === 0 && nearMissOpps.length === 0) return '';

    const lines: string[] = [
      '══════════════════════════════════════════════════════',
      'GSC REAL SEARCH DATA — use this to guide topic selection',
      '══════════════════════════════════════════════════════',
      '',
    ];

    if (topPages.length > 0) {
      lines.push('TOP PERFORMING PAGES (avg position < 10 — these topics resonate):');
      for (const page of topPages.slice(0, 6)) {
        const slug = this.extractSlug(page.page_url);
        const ctrPct = (Number(page.avg_ctr) * 100).toFixed(1);
        lines.push(
          `  • /${slug} | pos ${Number(page.avg_position).toFixed(1)} | CTR ${ctrPct}% | ${page.total_impr} impr/mo`
        );
      }
      lines.push('  → Pick adjacent topics that build on these themes.');
      lines.push('  → These pages earn internal link opportunities in new posts.');
      lines.push('');
    }

    if (nearMissOpps.length > 0) {
      lines.push('NEAR-MISS QUERIES (ranking 5–20, no dedicated post — proven demand):');
      for (const opp of nearMissOpps.slice(0, 8)) {
        let metrics: { avgPosition?: number; impressions?: number } = {};
        try { metrics = JSON.parse(opp.metrics_json) as typeof metrics; } catch { /* skip */ }
        const posStr = metrics.avgPosition ? `pos ${metrics.avgPosition.toFixed(1)}` : '';
        const imprStr = metrics.impressions ? `${metrics.impressions} impr/mo` : '';
        lines.push(`  • "${opp.query}" | ${posStr} | ${imprStr} → OPPORTUNITY`);
      }
      lines.push('  → These keywords are ALREADY in the database with gsc_sourced=1 and will appear in candidates.');
      lines.push('  → If you see them in the candidate list, PRIORITIZE them — real people are searching.');
      lines.push('');
    }

    lines.push('══════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Get GSC context for a specific keyword being generated.
   * Returns related queries already driving traffic to the site.
   */
  async getKeywordOpportunityContext(keyword: string, websiteId: string): Promise<GscKeywordContext | null> {
    const keywordWords = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (keywordWords.length === 0) return null;

    // Find queries in gsc_performance that share meaningful words with the keyword
    const likeClauses = keywordWords.map(() => 'query LIKE ?').join(' OR ');
    const likeParams = keywordWords.map(w => `%${w}%`);

    const startDate = this.getDateDaysAgo(28);

    const [rows] = await this.pool.query<TopQueryForKeywordRow[]>(
      `SELECT query, SUM(impressions) as impressions, AVG(position) as avg_position
       FROM gsc_performance
       WHERE website_id = ?
         AND date >= ?
         AND (${likeClauses})
       GROUP BY query
       HAVING impressions >= 20
       ORDER BY impressions DESC
       LIMIT 10`,
      [websiteId, startDate, ...likeParams]
    );

    if (rows.length === 0) return null;

    return {
      relatedQueries: rows.map(r => ({
        query: r.query,
        impressions: Number(r.impressions),
        avgPosition: Number(r.avg_position),
      })),
      existingCoverage: rows.some(r => Number(r.avg_position) < 10),
    };
  }

  /**
   * Format keyword GSC context as a prompt-ready string for blogGeneration.
   */
  formatKeywordContextForPrompt(keyword: string, ctx: GscKeywordContext): string {
    if (ctx.relatedQueries.length === 0) return '';

    const lines: string[] = [
      '──────────────────────────────────────────────────────',
      `GSC SIGNALS FOR "${keyword}"`,
      '──────────────────────────────────────────────────────',
      'Real searches driving traffic to this site on related queries:',
    ];

    for (const q of ctx.relatedQueries.slice(0, 5)) {
      const posStr = q.avgPosition < 100 ? ` | pos ${q.avgPosition.toFixed(1)}` : '';
      lines.push(`  • "${q.query}" → ${q.impressions} impr/mo${posStr}`);
    }

    lines.push('');
    lines.push('WHAT THIS MEANS FOR YOUR CONTENT:');
    lines.push('  • These are the EXACT words real people use — match this language in your title and headings.');

    // Identify if users say "cost" vs "price", "hire" vs "find", etc.
    const allQueries = ctx.relatedQueries.map(q => q.query.toLowerCase()).join(' ');
    if (allQueries.includes('cost') || allQueries.includes('price')) {
      lines.push('  • Searchers care about COST — include specific dollar figures early.');
    }
    if (allQueries.includes('hire') || allQueries.includes('find')) {
      lines.push('  • Searchers want to HIRE someone — make your CTA about booking a call, not "learn more".');
    }
    if (allQueries.includes('how to') || allQueries.includes('guide')) {
      lines.push('  • Searchers want actionable steps — include a numbered list or clear process.');
    }

    // Near-miss hint
    const nearMiss = ctx.relatedQueries.filter(q => q.avgPosition >= 5 && q.avgPosition <= 20);
    if (nearMiss.length > 0) {
      lines.push(`  • ${nearMiss.length} query/queries rank 5–20 — add FAQ items that directly answer these.`);
    }

    lines.push('──────────────────────────────────────────────────────');

    return lines.join('\n');
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private async getTopPerformingPages(websiteId: string): Promise<TopPageRow[]> {
    const startDate = this.getDateDaysAgo(28);
    const endDate = this.getDateDaysAgo(0);

    const [rows] = await this.pool.query<TopPageRow[]>(
      `SELECT page_url, post_id, avg_position, total_impr, avg_ctr
       FROM gsc_page_metrics
       WHERE website_id = ?
         AND period_start >= ?
         AND period_end <= ?
         AND avg_position < 10
         AND total_impr >= 50
       ORDER BY total_impr DESC
       LIMIT 10`,
      [websiteId, startDate, endDate]
    );

    return rows;
  }

  private async getPendingNearMissOpportunities(websiteId: string): Promise<NearMissRow[]> {
    const [rows] = await this.pool.query<NearMissRow[]>(
      `SELECT query, metrics_json, post_id
       FROM gsc_opportunities
       WHERE website_id = ?
         AND opportunity_type = 'near_miss'
         AND status = 'pending'
         AND query IS NOT NULL
       ORDER BY priority ASC
       LIMIT 10`,
      [websiteId]
    );

    return rows;
  }

  private extractSlug(pageUrl: string): string {
    try {
      const url = new URL(pageUrl);
      return url.pathname.replace(/^\/+|\/+$/g, '') || url.hostname;
    } catch {
      return pageUrl;
    }
  }

  private getDateDaysAgo(days: number): string {
    const d = new Date(Date.now() - days * 86400000);
    return d.toISOString().split('T')[0]!;
  }
}
