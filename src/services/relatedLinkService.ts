import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { Pool as PgPool } from 'pg';
import { buildPostUrl } from './sitemapService.js';

export interface RelatedLinkDeps {
  mysql: MysqlPool;
  postgres: PgPool;
}

/**
 * Builds the internal-link graph from EMBEDDINGS (no LLM): each published post is linked
 * to its most similar siblings on the same site. This un-orphans posts so Google can
 * discover them via internal links, and forms topical clusters — without spending the
 * (heavily capped) LLM quota that category-based linking would need.
 *
 * Writes content_json.internalLinks. The Next.js app must render these as <a> links for
 * them to help discovery. Merged posts are excluded (status='published' filter), and are
 * never used as link targets.
 */
export class RelatedLinkService {
  constructor(private readonly deps: RelatedLinkDeps) {}

  async injectEmbeddingLinks(opts: { perPost?: number; minSimilarity?: number } = {}): Promise<{ processed: number; updated: number }> {
    const perPost = opts.perPost ?? 6;
    const minSim = opts.minSimilarity ?? 0.4;

    const [rows] = await this.deps.mysql.query<RowDataPacket[]>(
      `SELECT p.id, p.slug, p.website_id, p.content_json, w.domain
         FROM posts p JOIN websites w ON w.id = p.website_id
        WHERE p.status = 'published' AND p.slug IS NOT NULL AND w.domain IS NOT NULL`
    );
    const meta = new Map<string, { slug: string; websiteId: string; domain: string; content: unknown }>();
    for (const r of rows as any[]) {
      meta.set(String(r.id), {
        slug: String(r.slug), websiteId: String(r.website_id), domain: String(r.domain), content: r.content_json,
      });
    }

    const pg = await this.deps.postgres.query(`SELECT entity_id, embedding FROM embeddings WHERE entity_type = 'post'`);
    const ids: string[] = [];
    const vecs: number[][] = [];
    for (const row of pg.rows as any[]) {
      const id = String(row.entity_id);
      if (!meta.has(id)) continue;
      const v = parseVec(row.embedding);
      if (!v) continue;
      ids.push(id);
      vecs.push(v);
    }
    const n = ids.length;
    if (n === 0) return { processed: 0, updated: 0 };

    const norm = vecs.map((v) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); });
    const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

    let updated = 0;
    for (let i = 0; i < n; i++) {
      const mi = meta.get(ids[i]!)!;
      const scored: Array<{ j: number; s: number }> = [];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (meta.get(ids[j]!)!.websiteId !== mi.websiteId) continue; // same site only
        const s = dot(norm[i]!, norm[j]!);
        if (s >= minSim) scored.push({ j, s });
      }
      scored.sort((a, b) => b.s - a.s);
      const links = scored.slice(0, perPost).map((t) => {
        const mj = meta.get(ids[t.j]!)!;
        return buildPostUrl(mj.domain, mj.slug);
      });
      if (links.length === 0) continue;

      const content = parseContent(mi.content);
      if (!content || typeof content !== 'object') continue;
      (content as any).internalLinks = links;

      await this.deps.mysql.query<ResultSetHeader>(
        `UPDATE posts SET content_json = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(content), ids[i]!]
      );
      updated++;
    }

    return { processed: n, updated };
  }
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
