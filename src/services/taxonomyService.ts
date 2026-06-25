import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { GeminiClient } from '../llm/geminiClient.js';
import { toSlug } from '../utils/slug.js';
import { safeJsonParse } from '../utils/json.js';
import { taxonomyClassificationPrompt, taxonomyPageContentPrompt } from '../prompts/taxonomy.js';
import { buildPostUrl, buildCategoryUrl } from './sitemapService.js';
import { WebsiteService } from './websiteService.js';

export interface TaxonomyServiceDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
}

const MAX_CATEGORIES = 3;
const MAX_TAGS = 6;
const RELATED_LINKS = 5;

const classificationSchema = z.object({
  categories: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([])
});

const pageContentSchema = z.object({
  seo_content: z.string().min(1),
  meta_title: z.string().min(1),
  meta_description: z.string().min(1)
});

export class TaxonomyService {
  private readonly websiteService: WebsiteService;

  constructor(private readonly deps: TaxonomyServiceDeps) {
    this.websiteService = new WebsiteService(deps.pool);
  }

  /**
   * Classify a single post into 1–3 existing categories + up to 6 tags, persist the
   * links, and inject internal links (category hub + related posts) into its content_json.
   * Best-effort: callers should treat failures as non-fatal.
   */
  async assignTaxonomy(postId: string): Promise<{ categories: string[]; tags: string[] }> {
    const [[postRow]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT p.id, p.website_id, p.title, p.primary_keyword, p.meta_description,
              p.target_icp, p.content_json, w.domain
         FROM posts p
         JOIN websites w ON w.id = p.website_id
        WHERE p.id = ?`,
      [postId]
    );
    const post = postRow as any;
    if (!post || !post.website_id) {
      return { categories: [], tags: [] };
    }

    const [catRows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, name, slug, description FROM categories WHERE website_id = ?`,
      [post.website_id]
    );
    const categories = catRows as Array<{ id: string; name: string; slug: string; description: string | null }>;
    if (categories.length === 0) {
      return { categories: [], tags: [] };
    }

    const summary = this.extractSummary(post.content_json, post.meta_description);

    const prompt = taxonomyClassificationPrompt({
      title: String(post.title),
      keyword: String(post.primary_keyword),
      summary,
      targetIcp: post.target_icp ?? null,
      categories: categories.map((c) => ({ name: c.name, description: c.description })),
      maxCategories: MAX_CATEGORIES,
      maxTags: MAX_TAGS
    });

    const raw = await this.deps.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.2,
      maxOutputTokens: 1024
    });

    const parsed = classificationSchema.parse(safeJsonParse(raw));

    // Map returned category names to known categories (case-insensitive), keep order, dedupe.
    const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c] as const));
    const matchedCats: typeof categories = [];
    for (const name of parsed.categories) {
      const hit = byName.get(name.trim().toLowerCase());
      if (hit && !matchedCats.some((c) => c.id === hit.id)) matchedCats.push(hit);
      if (matchedCats.length >= MAX_CATEGORIES) break;
    }

    // Link categories (first is primary).
    for (let i = 0; i < matchedCats.length; i++) {
      await this.deps.pool.query<ResultSetHeader>(
        `INSERT IGNORE INTO post_categories (post_id, category_id, is_primary) VALUES (?, ?, ?)`,
        [postId, matchedCats[i]!.id, i === 0 ? 1 : 0]
      );
    }

    // Upsert + link tags.
    const linkedTags: string[] = [];
    for (const rawTag of parsed.tags.slice(0, MAX_TAGS)) {
      const name = rawTag.trim().toLowerCase();
      const slug = toSlug(name);
      if (!slug) continue;
      const tagId = await this.upsertTag(post.website_id, name, slug);
      if (!tagId) continue;
      await this.deps.pool.query<ResultSetHeader>(
        `INSERT IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)`,
        [postId, tagId]
      );
      linkedTags.push(name);
    }

    await this.applyInternalLinks(postId, post.website_id, String(post.domain), post.content_json);

    return { categories: matchedCats.map((c) => c.name), tags: linkedTags };
  }

  /**
   * Categorize any PUBLISHED post that has no category yet (capped per run). Covers posts
   * that reached 'published' outside the main generation loop (rewrites, prior backlog).
   * Returns the number of posts categorized.
   */
  async backfillUncategorizedPublished(limit: number): Promise<number> {
    if (limit <= 0) return 0;
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT p.id
         FROM posts p
        WHERE p.status = 'published'
          AND p.website_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM post_categories pc WHERE pc.post_id = p.id)
        ORDER BY p.updated_at DESC
        LIMIT ?`,
      [limit]
    );

    let done = 0;
    for (const r of rows as any[]) {
      try {
        await this.assignTaxonomy(String(r.id));
        done++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`[TaxonomyService] ⚠️ backfill failed for post ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return done;
  }

  /** Find-or-create a tag for a website, returning its id. */
  private async upsertTag(websiteId: string, name: string, slug: string): Promise<string | null> {
    const id = crypto.randomUUID();
    await this.deps.pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO tags (id, website_id, name, slug) VALUES (?, ?, ?, ?)`,
      [id, websiteId, name, slug]
    );
    const [[row]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id FROM tags WHERE website_id = ? AND slug = ?`,
      [websiteId, slug]
    );
    return row ? String((row as any).id) : null;
  }

  /**
   * Compute the canonical internal-link set for a post: its primary category hub plus
   * up to 5 related published posts (shared category or tag). This is the authoritative
   * set — it replaces any links the generator may have invented.
   */
  private async computeInternalLinks(postId: string, websiteId: string, domain: string): Promise<string[]> {
    const links: string[] = [];

    const [[catRow]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT c.slug FROM categories c
         JOIN post_categories pc ON pc.category_id = c.id
        WHERE pc.post_id = ? AND pc.is_primary = 1
        LIMIT 1`,
      [postId]
    );
    if (catRow) links.push(buildCategoryUrl(domain, String((catRow as any).slug)));

    const [relatedRows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT DISTINCT p.slug
         FROM posts p
        WHERE p.website_id = ?
          AND p.status = 'published'
          AND p.id <> ?
          AND (
            p.id IN (SELECT post_id FROM post_categories WHERE category_id IN
                       (SELECT category_id FROM post_categories WHERE post_id = ?))
            OR p.id IN (SELECT post_id FROM post_tags WHERE tag_id IN
                       (SELECT tag_id FROM post_tags WHERE post_id = ?))
          )
        LIMIT ?`,
      [websiteId, postId, postId, postId, RELATED_LINKS]
    );
    for (const r of relatedRows as any[]) {
      links.push(buildPostUrl(domain, String(r.slug)));
    }

    return [...new Set(links)];
  }

  /**
   * Rebuild a post's content_json.internalLinks from the canonical set and stamp
   * links_refreshed_at. Only rewrites content_json (and bumps updated_at) when the link
   * set actually changed, so periodic refreshes don't churn lastmod for unchanged posts.
   */
  private async applyInternalLinks(
    postId: string,
    websiteId: string,
    domain: string,
    contentJson: unknown
  ): Promise<'updated' | 'unchanged'> {
    const links = await this.computeInternalLinks(postId, websiteId, domain);
    const content = this.parseContent(contentJson);

    // Nothing useful to write (or unparseable content) — stamp so we don't reselect it forever.
    if (links.length === 0 || !content || typeof content !== 'object') {
      await this.deps.pool.query<ResultSetHeader>(`UPDATE posts SET links_refreshed_at = NOW() WHERE id = ?`, [postId]);
      return 'unchanged';
    }

    const existing = Array.isArray((content as any).internalLinks)
      ? ((content as any).internalLinks as unknown[]).map(String)
      : [];

    if (sameSet(existing, links)) {
      await this.deps.pool.query<ResultSetHeader>(`UPDATE posts SET links_refreshed_at = NOW() WHERE id = ?`, [postId]);
      return 'unchanged';
    }

    (content as any).internalLinks = links;
    await this.deps.pool.query<ResultSetHeader>(
      `UPDATE posts SET content_json = ?, updated_at = NOW(), links_refreshed_at = NOW() WHERE id = ?`,
      [JSON.stringify(content), postId]
    );
    return 'updated';
  }

  /**
   * Rebuild internal links for published posts that were never linked, had their links
   * wiped by a rewrite, or are due for a periodic refresh as the cluster grows. Selecting
   * by links_refreshed_at (NULLs first, then older than `staleDays`) makes this self-
   * limiting — a refreshed post won't be reselected until it goes stale again.
   */
  async refreshInternalLinks(limit: number, staleDays = 7): Promise<{ processed: number; updated: number }> {
    if (limit <= 0) return { processed: 0, updated: 0 };

    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT p.id, p.website_id, p.content_json, w.domain
         FROM posts p
         JOIN websites w ON w.id = p.website_id
        WHERE p.status = 'published'
          AND EXISTS (SELECT 1 FROM post_categories pc WHERE pc.post_id = p.id)
          AND (p.links_refreshed_at IS NULL OR p.links_refreshed_at < DATE_SUB(NOW(), INTERVAL ? DAY))
        ORDER BY p.links_refreshed_at ASC
        LIMIT ?`,
      [staleDays, limit]
    );

    let updated = 0;
    for (const r of rows as any[]) {
      try {
        const result = await this.applyInternalLinks(String(r.id), String(r.website_id), String(r.domain), r.content_json);
        if (result === 'updated') updated++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`[TaxonomyService] ⚠️ link refresh failed for post ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { processed: (rows as any[]).length, updated };
  }

  /**
   * Recompute published-post counts for every category and tag, and flip tag indexability
   * based on the threshold. Runs centrally each pipeline run so counts stay correct
   * regardless of when posts move from draft to published.
   */
  async recomputeCountsAndIndexability(): Promise<{ indexableTags: number }> {
    await this.deps.pool.query(
      `UPDATE categories c
          SET c.post_count = (
            SELECT COUNT(*) FROM post_categories pc
              JOIN posts p ON p.id = pc.post_id
             WHERE pc.category_id = c.id AND p.status = 'published'
          )`
    );

    await this.deps.pool.query(
      `UPDATE tags t
          SET t.post_count = (
            SELECT COUNT(*) FROM post_tags pt
              JOIN posts p ON p.id = pt.post_id
             WHERE pt.tag_id = t.id AND p.status = 'published'
          )`
    );

    await this.deps.pool.query(
      `UPDATE tags SET is_indexable = CASE WHEN post_count >= ? THEN 1 ELSE 0 END`,
      [env.TAG_INDEX_MIN_POSTS]
    );

    const [[row]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM tags WHERE is_indexable = 1`
    );
    return { indexableTags: Number((row as any)?.cnt ?? 0) };
  }

  /**
   * Generate unique hub-page content for categories/tags that need it (missing content,
   * or new posts added since last generation). Capped per run to control LLM cost.
   */
  async generatePendingPageContent(limit: number): Promise<{ categories: number; tags: number }> {
    if (limit <= 0) return { categories: 0, tags: 0 };

    let budget = limit;
    let cats = 0;
    let tags = 0;

    // Categories first (they are the primary SEO assets).
    const [catRows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, website_id, name, slug, description, post_count
         FROM categories
        WHERE post_count > 0 AND (seo_content IS NULL OR content_post_count < post_count)
        ORDER BY post_count DESC
        LIMIT ?`,
      [budget]
    );
    for (const c of catRows as any[]) {
      if (budget <= 0) break;
      const ok = await this.generateOnePage('category', c.id, c.website_id, c.name, c.slug, c.description, c.post_count);
      if (ok) { cats++; budget--; }
    }

    if (budget > 0) {
      const [tagRows] = await this.deps.pool.query<RowDataPacket[]>(
        `SELECT id, website_id, name, slug, post_count
           FROM tags
          WHERE is_indexable = 1 AND (seo_content IS NULL OR content_post_count < post_count)
          ORDER BY post_count DESC
          LIMIT ?`,
        [budget]
      );
      for (const t of tagRows as any[]) {
        if (budget <= 0) break;
        const ok = await this.generateOnePage('tag', t.id, t.website_id, t.name, t.slug, null, t.post_count);
        if (ok) { tags++; budget--; }
      }
    }

    return { categories: cats, tags };
  }

  private async generateOnePage(
    type: 'category' | 'tag',
    id: string,
    websiteId: string,
    name: string,
    _slug: string,
    description: string | null,
    postCount: number
  ): Promise<boolean> {
    try {
      const website = await this.websiteService.getById(websiteId);
      if (!website) return false;

      const joinTable = type === 'category' ? 'post_categories' : 'post_tags';
      const fkCol = type === 'category' ? 'category_id' : 'tag_id';
      const [postRows] = await this.deps.pool.query<RowDataPacket[]>(
        `SELECT p.title, p.primary_keyword
           FROM posts p
           JOIN ${joinTable} j ON j.post_id = p.id
          WHERE j.${fkCol} = ? AND p.status = 'published'
          ORDER BY p.updated_at DESC
          LIMIT 25`,
        [id]
      );
      const posts = (postRows as any[]).map((p) => ({ title: String(p.title), keyword: String(p.primary_keyword) }));
      if (posts.length === 0) return false;

      const prompt = taxonomyPageContentPrompt({
        type,
        name,
        description,
        websiteDomain: website.domain,
        brandName: website.brandName,
        voiceInstructions: this.websiteService.getVoiceInstructions(website),
        posts
      });

      const raw = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: prompt.user,
        temperature: 0.5,
        maxOutputTokens: 2048
      });

      const content = pageContentSchema.parse(safeJsonParse(raw));
      const table = type === 'category' ? 'categories' : 'tags';
      await this.deps.pool.query<ResultSetHeader>(
        `UPDATE ${table}
            SET seo_content = ?, meta_title = ?, meta_description = ?,
                content_generated_at = NOW(), content_post_count = ?
          WHERE id = ?`,
        [content.seo_content, content.meta_title.slice(0, 255), content.meta_description.slice(0, 500), postCount, id]
      );
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[TaxonomyService] ⚠️ page content generation failed for ${type} "${name}": ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private parseContent(contentJson: unknown): unknown {
    if (contentJson == null) return null;
    if (typeof contentJson === 'string') {
      try { return JSON.parse(contentJson); } catch { return null; }
    }
    return contentJson; // mysql2 returns JSON columns pre-parsed
  }

  private extractSummary(contentJson: unknown, fallback: string | null): string {
    const content = this.parseContent(contentJson) as any;
    const parts: string[] = [];
    if (content?.hero?.hook) parts.push(String(content.hero.hook));
    if (Array.isArray(content?.sections) && content.sections[0]?.content) {
      parts.push(String(content.sections[0].content));
    }
    const text = parts.join(' ').trim();
    return (text || fallback || '').slice(0, 700);
  }
}

/** Order-insensitive equality for two string lists (treated as sets). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((x) => setA.has(x));
}
