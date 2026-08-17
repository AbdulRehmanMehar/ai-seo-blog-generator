/**
 * TAG BACKFILL — generate tags for existing posts WITHOUT an LLM.
 *
 * Extracts recurring key-phrases (bi/tri-grams) from each post's title + primary keyword,
 * keeps only phrases shared by >= MIN_DF posts on the same site (so no thin 1-post tags),
 * creates those as tags, and assigns posts to them. Then recomputes tag indexability
 * (a tag page goes indexable only at TAG_INDEX_MIN_POSTS) and refreshes the sitemaps.
 *
 * Run: npx tsx scripts/tag-backfill.ts
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import crypto from 'node:crypto';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { toSlug } from '../src/utils/slug.js';
import { TaxonomyService } from '../src/services/taxonomyService.js';
import { SitemapService } from '../src/services/sitemapService.js';

const MIN_DF = 4;            // a phrase must appear in >= 4 posts to become a tag
const MAX_TAGS_PER_SITE = 60;
const MAX_TAGS_PER_POST = 6;

const STOP = new Set(['the','a','an','and','or','for','to','of','in','on','your','you','with','how','why','what','is','are','that','this','from','it','as','at','by','be','not','no','can','will','should','do','does','when','who','where','into','about','our','their','its','his','her','they','we','i','my','me','us','than','then','so','if','but','out','up','more','most','any','all','you','yours']);

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Meaningful bi/tri-grams: boundaries can't be stopwords, tokens must be ≥3 chars. */
function phrases(toks: string[]): Set<string> {
  const out = new Set<string>();
  const ok = (t: string) => t.length >= 3;
  for (let i = 0; i < toks.length; i++) {
    for (const n of [2, 3]) {
      if (i + n > toks.length) continue;
      const gram = toks.slice(i, i + n);
      if (STOP.has(gram[0]!) || STOP.has(gram[n - 1]!)) continue;
      if (!gram.every(ok)) continue;
      if (gram.filter((t) => !STOP.has(t)).length < 2) continue; // need ≥2 content words
      out.add(gram.join(' '));
    }
  }
  return out;
}

async function upsertTag(websiteId: string, name: string, slug: string): Promise<string> {
  await mysqlPool.query<ResultSetHeader>(
    `INSERT IGNORE INTO tags (id, website_id, name, slug) VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), websiteId, name, slug]
  );
  const [[row]] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id FROM tags WHERE website_id = ? AND slug = ?`, [websiteId, slug]
  );
  return String((row as any).id);
}

async function main() {
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, title, primary_keyword, website_id FROM posts WHERE status = 'published'`
  );
  // Group posts by website with their phrase sets.
  const bySite = new Map<string, Array<{ id: string; grams: Set<string> }>>();
  for (const r of rows as any[]) {
    const grams = phrases(tokens(`${r.title} ${r.primary_keyword ?? ''}`));
    const wid = String(r.website_id);
    (bySite.get(wid) ?? bySite.set(wid, []).get(wid)!).push({ id: String(r.id), grams });
  }

  let totalTags = 0;
  let totalAssign = 0;

  for (const [websiteId, posts] of bySite) {
    // Document frequency per phrase.
    const df = new Map<string, string[]>();
    for (const p of posts) for (const g of p.grams) (df.get(g) ?? df.set(g, []).get(g)!).push(p.id);

    // Candidate tags: phrases in >= MIN_DF posts, top N by frequency.
    const candidates = [...df.entries()]
      .filter(([, ids]) => ids.length >= MIN_DF)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_TAGS_PER_SITE);

    const perPost = new Map<string, number>();
    for (const [phrase, postIds] of candidates) {
      const slug = toSlug(phrase);
      if (!slug) continue;
      const tagId = await upsertTag(websiteId, phrase, slug);
      totalTags++;
      for (const postId of postIds) {
        if ((perPost.get(postId) ?? 0) >= MAX_TAGS_PER_POST) continue;
        const [res] = await mysqlPool.query<ResultSetHeader>(
          `INSERT IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)`, [postId, tagId]
        );
        if ((res.affectedRows ?? 0) > 0) { perPost.set(postId, (perPost.get(postId) ?? 0) + 1); totalAssign++; }
      }
    }
  }

  console.log(`✓ Created ${totalTags} tags, ${totalAssign} post-tag assignments`);

  // Recompute tag counts + indexability (tag indexable only at TAG_INDEX_MIN_POSTS).
  const taxonomy = new TaxonomyService({ pool: mysqlPool, gemini: null as any });
  const { indexableTags } = await taxonomy.recomputeCountsAndIndexability();
  console.log(`✓ Indexable tags (>= threshold posts): ${indexableTags}`);

  // Show a few top tags.
  const [top] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT w.domain, t.name, t.post_count, t.is_indexable
       FROM tags t JOIN websites w ON w.id = t.website_id
      ORDER BY t.post_count DESC LIMIT 15`
  );
  console.log('\nTop tags:');
  for (const r of top as any[]) console.log(`   ${String(r.post_count).padStart(3)} posts ${r.is_indexable ? '[indexable]' : '[noindex] '} ${r.domain} — ${r.name}`);

  // Refresh sitemaps (now include indexable tag pages).
  const maps = await new SitemapService(mysqlPool).generateAll();
  for (const m of maps) console.log(`\n✓ ${m.filePath} (${m.urlCount} URLs)`);

  await mysqlPool.end();
  console.log('\n✅ Tag backfill complete.');
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
