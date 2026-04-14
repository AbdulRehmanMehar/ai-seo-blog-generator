import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import type { GeminiClient } from '../llm/geminiClient.js';
import { ctrOptimizePrompt, fullRefreshPrompt } from '../prompts/contentRefresh.js';
import type { BlogPostStructure } from '../prompts/blogGeneration.js';
import type { DecliningPost } from './gscOpportunityDetector.js';

interface RefreshQueueRow extends RowDataPacket {
  id: string;
  post_id: string;
  website_id: string;
  refresh_type: 'full_refresh' | 'ctr_optimize' | 'section_expand';
  trigger_type: 'declining' | 'low_ctr' | 'near_miss' | 'manual';
  opportunity_id: string | null;
  gsc_context_json: string | null;
  attempts: number;
}

interface PostRow extends RowDataPacket {
  id: string;
  title: string;
  slug: string;
  primary_keyword: string;
  content_json: string;
  website_id: string;
}

export interface RefreshResult {
  processed: number;
  succeeded: number;
  failed: number;
}

export interface CtrOptimizationResult {
  optimized: number;
  failed: number;
}

/**
 * Processes the content_refresh_queue.
 * Handles three refresh types:
 * - full_refresh: Rewrites post body with GSC context (freshen + near-miss capture)
 * - ctr_optimize: Rewrites only title + meta fields
 * - section_expand: Adds one new section or FAQ item targeting a near-miss query
 */
export class ContentRefreshService {
  constructor(
    private readonly pool: MysqlPool,
    private readonly gemini: GeminiClient
  ) {}

  /**
   * Queue declining posts for full refresh.
   */
  async queueRefreshes(declining: DecliningPost[], websiteId: string): Promise<number> {
    let queued = 0;

    for (const post of declining) {
      // Don't double-queue
      const [existing] = await this.pool.query<RowDataPacket[]>(
        `SELECT id FROM content_refresh_queue
         WHERE post_id = ? AND status IN ('queued', 'processing')
         LIMIT 1`,
        [post.postId]
      );
      if ((existing as RowDataPacket[]).length > 0) continue;

      const id = crypto.randomUUID();
      const gscContext = {
        decline: {
          baselinePosition: post.baselinePosition,
          currentPosition: post.currentPosition,
          positionChange: post.positionChange,
          clickDelta: post.clickDelta,
        },
      };

      await this.pool.query<ResultSetHeader>(
        `INSERT INTO content_refresh_queue
           (id, post_id, website_id, refresh_type, trigger_type, gsc_context_json)
         VALUES (?, ?, ?, 'full_refresh', 'declining', ?)`,
        [id, post.postId, websiteId, JSON.stringify(gscContext)]
      );
      queued++;
    }

    return queued;
  }

  /**
   * Process one item from the refresh queue.
   * Cap: 1 post per call (full refreshes are expensive LLM calls).
   */
  async processRefreshQueue(): Promise<RefreshResult> {
    const [rows] = await this.pool.query<RefreshQueueRow[]>(
      `SELECT * FROM content_refresh_queue
       WHERE status = 'queued' AND attempts < 3
       ORDER BY queued_at ASC
       LIMIT 1`
    );

    if (rows.length === 0) return { processed: 0, succeeded: 0, failed: 0 };

    const item = rows[0]!;
    await this.pool.query<ResultSetHeader>(
      `UPDATE content_refresh_queue
       SET status = 'processing', started_at = NOW(), attempts = attempts + 1
       WHERE id = ?`,
      [item.id]
    );

    try {
      const [postRows] = await this.pool.query<PostRow[]>(
        `SELECT p.id, p.title, p.slug, p.primary_keyword, p.content_json, p.website_id
         FROM posts p WHERE p.id = ?`,
        [item.post_id]
      );

      if (postRows.length === 0) {
        throw new Error(`Post ${item.post_id} not found`);
      }

      const post = postRows[0]!;
      let currentContent: BlogPostStructure;
      try {
        currentContent = JSON.parse(post.content_json) as BlogPostStructure;
      } catch {
        throw new Error(`Post ${item.post_id} has invalid content_json`);
      }

      let gscCtx: Record<string, unknown> = {};
      try {
        if (item.gsc_context_json) {
          gscCtx = JSON.parse(item.gsc_context_json) as typeof gscCtx;
        }
      } catch { /* non-fatal */ }

      if (item.refresh_type === 'ctr_optimize') {
        await this.runCtrOptimize(item, post, currentContent, gscCtx);
      } else {
        await this.runFullRefresh(item, post, currentContent, gscCtx);
      }

      await this.pool.query<ResultSetHeader>(
        `UPDATE content_refresh_queue
         SET status = 'done', completed_at = NOW()
         WHERE id = ?`,
        [item.id]
      );

      // Mark opportunity resolved if linked
      if (item.opportunity_id) {
        await this.pool.query<ResultSetHeader>(
          `UPDATE gsc_opportunities SET status = 'resolved', resolved_at = NOW(),
             resolution_note = 'Content refreshed'
           WHERE id = ?`,
          [item.opportunity_id]
        );
      }

      return { processed: 1, succeeded: 1, failed: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.pool.query<ResultSetHeader>(
        `UPDATE content_refresh_queue
         SET status = 'failed', error_message = ?, completed_at = NOW()
         WHERE id = ?`,
        [msg.slice(0, 500), item.id]
      );
      console.error(`[ContentRefresh] Failed to refresh post ${item.post_id}:`, msg);
      return { processed: 1, succeeded: 0, failed: 1 };
    }
  }

  /**
   * Rewrite only the title + meta fields for low-CTR pages.
   * Picks the top N low-CTR opportunities and optimizes each.
   */
  async runCtrOptimizations(limit = 3): Promise<CtrOptimizationResult> {
    const [opps] = await this.pool.query<RowDataPacket[]>(
      `SELECT o.id, o.post_id, o.metrics_json, o.website_id
       FROM gsc_opportunities o
       WHERE o.opportunity_type = 'low_ctr'
         AND o.status = 'pending'
         AND o.post_id IS NOT NULL
       ORDER BY o.priority ASC
       LIMIT ?`,
      [limit]
    );

    let optimized = 0;
    let failed = 0;

    for (const opp of opps as Array<{ id: string; post_id: string; metrics_json: string; website_id: string }>) {
      try {
        const [postRows] = await this.pool.query<PostRow[]>(
          `SELECT id, title, slug, primary_keyword, content_json, website_id FROM posts WHERE id = ?`,
          [opp.post_id]
        );
        if (postRows.length === 0) continue;

        const post = postRows[0]!;
        const currentContent = JSON.parse(post.content_json) as BlogPostStructure;
        const metrics = JSON.parse(opp.metrics_json) as {
          impressions?: number;
          ctr?: number;
          avgPosition?: number;
          topQueries?: string[];
        };

        const prompt = ctrOptimizePrompt({
          title: currentContent.title,
          metaTitle: currentContent.meta.title,
          metaDescription: currentContent.meta.description,
          keyword: post.primary_keyword,
          topQueries: metrics.topQueries ?? [],
          impressions: metrics.impressions ?? 0,
          ctr: metrics.ctr ?? 0,
          avgPosition: metrics.avgPosition ?? 0,
        });

        const raw = await this.gemini.generateText({
          systemInstruction: prompt.system,
          userPrompt: prompt.user,
          temperature: 0.4,
          maxOutputTokens: 512,
        });

        const ctrSchema = z.object({
          title: z.string().min(1),
          metaTitle: z.string().min(1),
          metaDescription: z.string().min(1),
        });

        const parsed = ctrSchema.parse(safeJsonParse(raw));

        // Patch only the title and meta fields
        const updatedContent: BlogPostStructure = {
          ...currentContent,
          title: parsed.title,
          meta: {
            ...currentContent.meta,
            title: parsed.metaTitle,
            description: parsed.metaDescription,
          },
        };

        await this.pool.query<ResultSetHeader>(
          `UPDATE posts SET content_json = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(updatedContent), post.id]
        );

        await this.pool.query<ResultSetHeader>(
          `UPDATE gsc_opportunities
           SET status = 'resolved', resolved_at = NOW(),
               resolution_note = ?
           WHERE id = ?`,
          [`CTR optimized: "${currentContent.title}" → "${parsed.title}"`, opp.id]
        );

        console.log(`[ContentRefresh] CTR optimized: "${post.primary_keyword}" | "${parsed.title}"`);
        optimized++;
      } catch (err) {
        console.error(`[ContentRefresh] CTR optimization failed for post ${opp.post_id}:`, err);
        failed++;
      }
    }

    return { optimized, failed };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async runCtrOptimize(
    item: RefreshQueueRow,
    post: PostRow,
    currentContent: BlogPostStructure,
    gscCtx: Record<string, unknown>
  ): Promise<void> {
    const metrics = gscCtx as {
      topQueries?: string[];
      impressions?: number;
      ctr?: number;
      avgPosition?: number;
    };

    const prompt = ctrOptimizePrompt({
      title: currentContent.title,
      metaTitle: currentContent.meta.title,
      metaDescription: currentContent.meta.description,
      keyword: post.primary_keyword,
      topQueries: metrics.topQueries ?? [],
      impressions: metrics.impressions ?? 0,
      ctr: metrics.ctr ?? 0,
      avgPosition: metrics.avgPosition ?? 0,
    });

    const raw = await this.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.4,
      maxOutputTokens: 512,
    });

    const ctrSchema = z.object({
      title: z.string().min(1),
      metaTitle: z.string().min(1),
      metaDescription: z.string().min(1),
    });

    const parsed = ctrSchema.parse(safeJsonParse(raw));
    const updatedContent: BlogPostStructure = {
      ...currentContent,
      title: parsed.title,
      meta: { ...currentContent.meta, title: parsed.metaTitle, description: parsed.metaDescription },
    };

    await this.pool.query<ResultSetHeader>(
      `UPDATE posts SET content_json = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(updatedContent), post.id]
    );
  }

  private async runFullRefresh(
    item: RefreshQueueRow,
    post: PostRow,
    currentContent: BlogPostStructure,
    gscCtx: Record<string, unknown>
  ): Promise<void> {
    const ctx = gscCtx as {
      decline?: { baselinePosition: number; currentPosition: number; positionChange: number; clickDelta: number };
      topQueries?: Array<{ query: string; impressions: number; avgPosition: number }>;
      nearMissQuery?: string;
      nearMissImpressions?: number;
      ga4?: { sessions?: number; bounceRate?: number; avgEngagementSec?: number };
    };

    const prompt = fullRefreshPrompt({
      currentPost: currentContent,
      keyword: post.primary_keyword,
      refreshType: item.refresh_type,
      gscContext: ctx,
    });

    const raw = await this.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.5,
      maxOutputTokens: 8192,
    });

    // Use same validation as blogGenerator — the output must be a valid BlogPostStructure
    const parsed = safeJsonParse(raw) as BlogPostStructure;
    if (!parsed || typeof parsed !== 'object' || !parsed.title) {
      throw new Error('Refresh response is not a valid BlogPostStructure');
    }

    // Preserve the original slug (never change URL)
    parsed.slug = currentContent.slug;

    await this.pool.query<ResultSetHeader>(
      `UPDATE posts SET content_json = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(parsed), post.id]
    );

    console.log(`[ContentRefresh] Full refresh done: "${post.primary_keyword}"`);
  }
}

function safeJsonParse(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('No valid JSON found in response');
  }
}
