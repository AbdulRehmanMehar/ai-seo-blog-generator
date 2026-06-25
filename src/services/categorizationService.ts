import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { Pool as PgPool } from 'pg';
import type { GeminiClient } from '../llm/geminiClient.js';
import { buildCategoryUrl } from './sitemapService.js';

export interface CategorizationDeps {
  mysql: MysqlPool;
  postgres: PgPool;
  gemini: GeminiClient;
}

/**
 * Assigns existing posts to the controlled category set using EMBEDDING SIMILARITY rather
 * than a per-post LLM call (which the 80/key/day cap makes infeasible at 566 posts).
 *
 * It embeds each category's name+description ONCE (~20 embedding calls total), then for
 * every published post compares its stored embedding to the categories of its own site and
 * assigns the nearest one (primary) plus any close runners-up. It also links each post to
 * its primary category hub (spoke → hub) via content_json.internalLinks.
 */
export class CategorizationService {
  constructor(private readonly deps: CategorizationDeps) {}

  async categorizeAll(opts: { maxPerPost?: number; secondaryMargin?: number; minSecondary?: number } = {}):
    Promise<{ categorized: number; assignments: number; categoriesEmbedded: number }> {
    const maxPerPost = opts.maxPerPost ?? 2;
    const secondaryMargin = opts.secondaryMargin ?? 0.05;
    const minSecondary = opts.minSecondary ?? 0.4;

    // 1. Load categories and embed each (name + description) once.
    const [catRows] = await this.deps.mysql.query<RowDataPacket[]>(
      `SELECT id, name, slug, description, website_id FROM categories`
    );
    const catVecs: Array<{ id: string; slug: string; websiteId: string; vec: number[] }> = [];
    for (const c of catRows as any[]) {
      const text = `${c.name}. ${c.description ?? ''}`.trim();
      const v = await this.deps.gemini.embedText(text);
      catVecs.push({ id: String(c.id), slug: String(c.slug), websiteId: String(c.website_id), vec: normalize(v) });
    }
    if (catVecs.length === 0) return { categorized: 0, assignments: 0, categoriesEmbedded: 0 };

    // 2. Load published posts + their stored embeddings.
    const [postRows] = await this.deps.mysql.query<RowDataPacket[]>(
      `SELECT p.id, p.slug, p.website_id, p.content_json, w.domain
         FROM posts p JOIN websites w ON w.id = p.website_id
        WHERE p.status = 'published' AND p.slug IS NOT NULL AND w.domain IS NOT NULL`
    );
    const postMeta = new Map<string, { websiteId: string; domain: string; content: unknown }>();
    for (const r of postRows as any[]) {
      postMeta.set(String(r.id), { websiteId: String(r.website_id), domain: String(r.domain), content: r.content_json });
    }

    const pg = await this.deps.postgres.query(`SELECT entity_id, embedding FROM embeddings WHERE entity_type = 'post'`);
    const postVecs = new Map<string, number[]>();
    for (const row of pg.rows as any[]) {
      const id = String(row.entity_id);
      if (!postMeta.has(id)) continue;
      const v = parseVec(row.embedding);
      if (v) postVecs.set(id, normalize(v));
    }

    // 3. Assign each post to its nearest category (+ close runners-up), link the hub.
    let categorized = 0;
    let assignments = 0;
    for (const [postId, pvec] of postVecs) {
      const pm = postMeta.get(postId)!;
      const scored = catVecs
        .filter((c) => c.websiteId === pm.websiteId)
        .map((c) => ({ id: c.id, slug: c.slug, sim: dot(pvec, c.vec) }))
        .sort((a, b) => b.sim - a.sim);
      if (scored.length === 0) continue;

      const primary = scored[0]!;
      const chosen = [primary];
      for (let k = 1; k < scored.length && chosen.length < maxPerPost; k++) {
        if (scored[k]!.sim >= primary.sim - secondaryMargin && scored[k]!.sim >= minSecondary) chosen.push(scored[k]!);
      }

      for (let i = 0; i < chosen.length; i++) {
        await this.deps.mysql.query<ResultSetHeader>(
          `INSERT IGNORE INTO post_categories (post_id, category_id, is_primary) VALUES (?, ?, ?)`,
          [postId, chosen[i]!.id, i === 0 ? 1 : 0]
        );
        assignments++;
      }

      // Prepend the primary category hub to internal links (spoke → hub), keep related links.
      const content = parseContent(pm.content);
      if (content && typeof content === 'object') {
        const hubUrl = buildCategoryUrl(pm.domain, primary.slug);
        const existing = Array.isArray((content as any).internalLinks) ? (content as any).internalLinks.map(String) : [];
        (content as any).internalLinks = [...new Set([hubUrl, ...existing])].slice(0, 8);
        await this.deps.mysql.query<ResultSetHeader>(
          `UPDATE posts SET content_json = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(content), postId]
        );
      }
      categorized++;
    }

    return { categorized, assignments, categoriesEmbedded: catVecs.length };
  }
}

function normalize(v: number[]): number[] {
  const m = Math.hypot(...v) || 1;
  return v.map((x) => x / m);
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
function parseVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') { try { return JSON.parse(v) as number[]; } catch { return null; } }
  return null;
}
function parseContent(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}
