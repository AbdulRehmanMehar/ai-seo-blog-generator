import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env.js';

export interface SitemapResult {
  websiteId: string;
  domain: string;
  urlCount: number;
  filePath: string;
}

export interface PublishedPostUrl {
  websiteId: string;
  domain: string;
  slug: string;
  url: string;
  lastmod: string; // ISO date (YYYY-MM-DD)
}

/**
 * Build a post's public URL from the configured BLOG_URL_PATTERN.
 * Placeholders: {domain} and {slug}.
 */
export function buildPostUrl(domain: string, slug: string, pattern: string = env.BLOG_URL_PATTERN): string {
  return pattern.replace('{domain}', domain).replace('{slug}', slug);
}

export function buildCategoryUrl(domain: string, slug: string, pattern: string = env.CATEGORY_URL_PATTERN): string {
  return pattern.replace('{domain}', domain).replace('{slug}', slug);
}

export function buildTagUrl(domain: string, slug: string, pattern: string = env.TAG_URL_PATTERN): string {
  return pattern.replace('{domain}', domain).replace('{slug}', slug);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/**
 * Generates an XML sitemap per website from its published posts.
 *
 * NOTE: the sitemap only helps Google if the live website actually serves it
 * (e.g. at https://{domain}/sitemap.xml) and references it from robots.txt /
 * submits it once in Search Console. This service produces the file; deploying
 * it alongside the site is a one-time manual step on the frontend.
 */
export class SitemapService {
  private readonly outDir: string;

  constructor(private readonly pool: MysqlPool, outDir?: string) {
    this.outDir = outDir ?? env.SITEMAP_DIR ?? env.EXPORT_DIR;
  }

  /** Load every published post with its website domain. */
  async getPublishedUrls(): Promise<PublishedPostUrl[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.slug, p.updated_at, p.website_id, w.domain
         FROM posts p
         JOIN websites w ON w.id = p.website_id
        WHERE p.status = 'published'
          AND p.slug IS NOT NULL
          AND w.domain IS NOT NULL
        ORDER BY p.updated_at DESC`
    );

    return (rows as any[]).map((r) => {
      const domain = String(r.domain);
      const slug = String(r.slug);
      return {
        websiteId: String(r.website_id),
        domain,
        slug,
        url: buildPostUrl(domain, slug),
        lastmod: toIsoDate(r.updated_at)
      };
    });
  }

  /** Load posts published or updated within the last `days` days (for IndexNow submission). */
  async getRecentlyPublishedUrls(days: number): Promise<PublishedPostUrl[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.slug, p.updated_at, p.website_id, w.domain
         FROM posts p
         JOIN websites w ON w.id = p.website_id
        WHERE p.status = 'published'
          AND p.slug IS NOT NULL
          AND w.domain IS NOT NULL
          AND p.updated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY p.updated_at DESC`,
      [days]
    );

    return (rows as any[]).map((r) => {
      const domain = String(r.domain);
      const slug = String(r.slug);
      return {
        websiteId: String(r.website_id),
        domain,
        slug,
        url: buildPostUrl(domain, slug),
        lastmod: toIsoDate(r.updated_at)
      };
    });
  }

  /**
   * Category hub URLs (only categories with at least one published post — empty hub
   * pages are thin) and indexable tag URLs (gated by post_count threshold in app code).
   */
  async getTaxonomyUrls(): Promise<PublishedPostUrl[]> {
    const out: PublishedPostUrl[] = [];

    const [catRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT c.slug, c.updated_at, c.website_id, w.domain
         FROM categories c
         JOIN websites w ON w.id = c.website_id
        WHERE c.post_count > 0 AND w.domain IS NOT NULL`
    );
    for (const r of catRows as any[]) {
      const domain = String(r.domain);
      const slug = String(r.slug);
      out.push({
        websiteId: String(r.website_id),
        domain,
        slug,
        url: buildCategoryUrl(domain, slug),
        lastmod: toIsoDate(r.updated_at)
      });
    }

    const [tagRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT t.slug, t.updated_at, t.website_id, w.domain
         FROM tags t
         JOIN websites w ON w.id = t.website_id
        WHERE t.is_indexable = 1 AND w.domain IS NOT NULL`
    );
    for (const r of tagRows as any[]) {
      const domain = String(r.domain);
      const slug = String(r.slug);
      out.push({
        websiteId: String(r.website_id),
        domain,
        slug,
        url: buildTagUrl(domain, slug),
        lastmod: toIsoDate(r.updated_at)
      });
    }

    return out;
  }

  /** Generate one sitemap.xml file per website. Returns a summary per website. */
  async generateAll(): Promise<SitemapResult[]> {
    const [postUrls, taxonomyUrls] = await Promise.all([
      this.getPublishedUrls(),
      this.getTaxonomyUrls()
    ]);
    const urls = [...postUrls, ...taxonomyUrls];
    if (urls.length === 0) return [];

    await fs.mkdir(this.outDir, { recursive: true });

    // Group URLs by website.
    const byDomain = new Map<string, { websiteId: string; domain: string; urls: PublishedPostUrl[] }>();
    for (const u of urls) {
      const group = byDomain.get(u.domain) ?? { websiteId: u.websiteId, domain: u.domain, urls: [] };
      group.urls.push(u);
      byDomain.set(u.domain, group);
    }

    const results: SitemapResult[] = [];
    for (const group of byDomain.values()) {
      const body = group.urls
        .map(
          (u) =>
            `  <url>\n    <loc>${xmlEscape(u.url)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`
        )
        .join('\n');

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `${body}\n` +
        `</urlset>\n`;

      const fileName = `sitemap-${group.domain}.xml`;
      const filePath = path.join(this.outDir, fileName);
      await fs.writeFile(filePath, xml, 'utf8');

      results.push({
        websiteId: group.websiteId,
        domain: group.domain,
        urlCount: group.urls.length,
        filePath
      });
    }

    return results;
  }
}
