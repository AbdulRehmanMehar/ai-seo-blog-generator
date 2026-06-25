import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { Pool as PgPool } from 'pg';

export interface ConsolidationDeps {
  mysql: MysqlPool;
  postgres: PgPool;
}

export interface PostMeta {
  id: string;
  title: string;
  slug: string;
  websiteId: string;
  indexState: string | null;
  contentLen: number;
  createdAt: string;
}

export interface ClusterPlan {
  survivor: PostMeta;
  /** Posts that will be marked merged and redirected to the survivor. */
  merged: PostMeta[];
}

export interface ConsolidationResult {
  clusters: number;
  postsMerged: number;
  plans: ClusterPlan[];
  applied: boolean;
  chainsFixed: number;
}

/**
 * Finds near-duplicate post clusters (via pgvector embeddings) and consolidates each into
 * a single survivor: the other posts are marked status='merged' and given
 * redirect_to_slug = survivor.slug, so the Next.js app 301s them to the survivor.
 *
 * Clusters are constrained to a single website (you can't 301 across domains) and only
 * include currently-published posts.
 */
export class ConsolidationService {
  constructor(private readonly deps: ConsolidationDeps) {}

  /**
   * Mark one post as merged into a survivor. Also CHAIN-PROOFS the graph: any post that
   * was already redirecting to this post is repointed to the survivor, so we always end up
   * with A→C and B→C, never A→B→C.
   */
  async markMerged(sourceId: string, sourceSlug: string, survivorSlug: string): Promise<boolean> {
    if (sourceSlug === survivorSlug) return false; // never self-redirect

    const [res] = await this.deps.mysql.query<ResultSetHeader>(
      `UPDATE posts SET status = 'merged', redirect_to_slug = ?, updated_at = NOW()
        WHERE id = ? AND status = 'published'`,
      [survivorSlug, sourceId]
    );

    // Repoint anything that pointed at the now-merged post → the survivor (flatten chains).
    await this.deps.mysql.query<ResultSetHeader>(
      `UPDATE posts SET redirect_to_slug = ?, updated_at = NOW()
        WHERE redirect_to_slug = ? AND id <> ?`,
      [survivorSlug, sourceSlug, sourceId]
    );

    return (res.affectedRows ?? 0) > 0;
  }

  /**
   * Repair pass: collapse any multi-hop redirect chain so every redirect points straight
   * to its FINAL published survivor. Cycle-safe. Safe to run anytime; returns rows fixed.
   */
  async flattenRedirects(): Promise<number> {
    const [rows] = await this.deps.mysql.query<RowDataPacket[]>(
      `SELECT id, slug, redirect_to_slug FROM posts WHERE redirect_to_slug IS NOT NULL`
    );
    // slug → its onward redirect target (only redirecting posts appear here).
    const next = new Map<string, string>();
    for (const r of rows as any[]) next.set(String(r.slug), String(r.redirect_to_slug));

    const resolveFinal = (target: string): string => {
      const seen = new Set<string>();
      let cur = target;
      while (next.has(cur) && !seen.has(cur)) { seen.add(cur); cur = next.get(cur)!; }
      return cur; // a slug with no onward redirect (the published survivor)
    };

    let fixed = 0;
    for (const r of rows as any[]) {
      const final = resolveFinal(String(r.redirect_to_slug));
      if (final && final !== String(r.redirect_to_slug)) {
        await this.deps.mysql.query<ResultSetHeader>(
          `UPDATE posts SET redirect_to_slug = ?, updated_at = NOW() WHERE id = ?`,
          [final, r.id]
        );
        fixed++;
      }
    }
    return fixed;
  }

  /**
   * Pick the survivor of a cluster. An already-indexed page MUST win (never redirect an
   * indexed URL away). Otherwise prefer the most substantial post (longest content), then
   * the most recent.
   */
  private pickSurvivor(cluster: PostMeta[]): PostMeta {
    return [...cluster].sort((a, b) => {
      const ai = a.indexState === 'indexed' ? 1 : 0;
      const bi = b.indexState === 'indexed' ? 1 : 0;
      if (ai !== bi) return bi - ai;
      if (b.contentLen !== a.contentLen) return b.contentLen - a.contentLen;
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    })[0]!;
  }

  /** Load published posts + their embeddings and union near-duplicates within a website. */
  async findClusters(threshold = 0.90): Promise<PostMeta[][]> {
    const [rows] = await this.deps.mysql.query<RowDataPacket[]>(
      `SELECT id, title, slug, website_id, index_state,
              CHAR_LENGTH(content_json) AS content_len, created_at
         FROM posts
        WHERE status = 'published' AND slug IS NOT NULL AND website_id IS NOT NULL`
    );
    const metaById = new Map<string, PostMeta>();
    for (const r of rows as any[]) {
      metaById.set(String(r.id), {
        id: String(r.id),
        title: String(r.title),
        slug: String(r.slug),
        websiteId: String(r.website_id),
        indexState: r.index_state ?? null,
        contentLen: Number(r.content_len ?? 0),
        createdAt: r.created_at ? String(r.created_at) : '',
      });
    }

    const pg = await this.deps.postgres.query(
      `SELECT entity_id, embedding FROM embeddings WHERE entity_type = 'post'`
    );
    const ids: string[] = [];
    const vecs: number[][] = [];
    for (const row of pg.rows as any[]) {
      const id = String(row.entity_id);
      if (!metaById.has(id)) continue; // skip non-published / merged
      const v = parseVec(row.embedding);
      if (!v) continue;
      ids.push(id);
      vecs.push(v);
    }
    const n = ids.length;
    if (n === 0) return [];

    // Normalize for cosine = dot product.
    const norm = vecs.map((v) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); });
    const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      // Only merge within the same website (can't 301 across domains).
      if (metaById.get(ids[i]!)!.websiteId !== metaById.get(ids[j]!)!.websiteId) continue;
      if (dot(norm[i]!, norm[j]!) >= threshold) union(i, j);
    }

    const groups = new Map<number, PostMeta[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      (groups.get(r) ?? groups.set(r, []).get(r)!).push(metaById.get(ids[i]!)!);
    }
    return [...groups.values()].filter((c) => c.length >= 2).sort((a, b) => b.length - a.length);
  }

  /**
   * Build the consolidation plan and (unless dryRun) apply it.
   * Returns the per-cluster survivor + merged list.
   */
  async consolidate(opts: { threshold?: number; dryRun?: boolean }): Promise<ConsolidationResult> {
    const threshold = opts.threshold ?? 0.90;
    const dryRun = opts.dryRun ?? true;
    const clusters = await this.findClusters(threshold);

    const plans: ClusterPlan[] = [];
    let postsMerged = 0;

    for (const cluster of clusters) {
      const survivor = this.pickSurvivor(cluster);
      const merged = cluster.filter((p) => p.id !== survivor.id);
      plans.push({ survivor, merged });
      postsMerged += merged.length;

      if (!dryRun) {
        for (const m of merged) await this.markMerged(m.id, m.slug, survivor.slug);
      }
    }

    // Final safety: flatten any chains (e.g. from a prior run) to their final survivor.
    const chainsFixed = dryRun ? 0 : await this.flattenRedirects();

    return { clusters: clusters.length, postsMerged, plans, applied: !dryRun, chainsFixed };
  }
}

function parseVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') { try { return JSON.parse(v) as number[]; } catch { return null; } }
  return null;
}
