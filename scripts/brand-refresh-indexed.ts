/**
 * TIER-2 BRAND REFRESH — refresh posts Google has INDEXED so the prose matches the
 * brand voice (data/brand.json) without risking their rankings.
 *
 *   npx tsx scripts/brand-refresh-indexed.ts                 # default 25 (a weekly batch)
 *   npx tsx scripts/brand-refresh-indexed.ts 5               # smaller batch
 *   npx tsx scripts/brand-refresh-indexed.ts --slug my-post  # one specific post (re-runs even if fresh)
 *   npx tsx scripts/brand-refresh-indexed.ts --slug my-post --retitle
 *       # also write a NEW brand-compliant title — only for pages with zero impressions
 *       # whose current title itself violates the brand (dollar claims, fear framing)
 *
 * Ranking safety: slug, title, and meta title are pinned to their current values;
 * real GSC queries for the page (when present) are fed to the prompt so the wording
 * that earns impressions stays in headings and openings. index_state stays 'indexed'.
 * Oldest-updated first, so re-running continues where the last batch stopped.
 * After the batch, refreshed URLs are pinged via IndexNow to prompt a re-crawl.
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { EmbeddingStore } from '../src/embeddings/embeddingStore.js';
import { postHumanizer } from '../src/services/postHumanizer.js';
import { brandRealignPrompt } from '../src/prompts/contentRefresh.js';
import { buildPostUrl, type PublishedPostUrl } from '../src/services/sitemapService.js';
import { CLIENT_NAME_BLOCKLIST, getAllowedNumericClaims } from '../src/knowledge/brandKnowledge.js';
import { IndexNowService } from '../src/services/indexNowService.js';
import { safeJsonParse } from '../src/utils/json.js';
import type { BlogPostStructure } from '../src/prompts/blogGeneration.js';

import {
  sanitizeTopicMap,
  redactViolatingSentences,
  screenBrandViolations,
} from '../src/services/brandRedaction.js';

async function main() {
  const slugFlag = process.argv.indexOf('--slug');
  const targetSlug = slugFlag >= 0 ? process.argv[slugFlag + 1] : undefined;
  const retitle = process.argv.includes('--retitle');
  if (retitle && !targetSlug) {
    throw new Error('--retitle requires --slug: retitling is a deliberate per-post decision, never a batch default.');
  }
  const limit = targetSlug ? 1 : Number(process.argv[2] ?? 25);
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  const gemini = new GeminiClient({
    rateLimiter: new GeminiRateLimiter(mysqlPool, apiKeys),
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_PROVIDER === 'openrouter' ? 0 : env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
  const embeddings = new EmbeddingStore(postgresPool);

  console.log(`Brand refresh (indexed posts) via ${env.LLM_PROVIDER === 'openrouter' ? env.OPENROUTER_MODEL : env.GEMINI_GENERATION_MODEL} | batch ${limit}\n`);

  const [rows] = targetSlug
    ? await mysqlPool.query<RowDataPacket[]>(
        `SELECT p.id, p.slug, p.primary_keyword, p.content_json, p.website_id, w.domain
           FROM posts p JOIN websites w ON w.id = p.website_id
          WHERE p.status = 'published' AND p.slug = ?`,
        [targetSlug]
      )
    : await mysqlPool.query<RowDataPacket[]>(
        `SELECT p.id, p.slug, p.primary_keyword, p.content_json, p.website_id, w.domain
           FROM posts p JOIN websites w ON w.id = p.website_id
          WHERE p.status = 'published' AND p.index_state = 'indexed'
          ORDER BY p.updated_at ASC
          LIMIT ?`,
        [limit]
      );

  const refreshed: PublishedPostUrl[] = [];
  let ok = 0, fail = 0;
  for (const r of rows as any[]) {
    try {
      const current = (typeof r.content_json === 'string' ? JSON.parse(r.content_json) : r.content_json) as BlogPostStructure;

      const [queryRows] = await mysqlPool.query<RowDataPacket[]>(
        `SELECT query, SUM(impressions) AS impressions, AVG(position) AS avgPosition
           FROM gsc_performance
          WHERE website_id = ? AND page_url LIKE CONCAT('%/', ?)
            AND date >= CURDATE() - INTERVAL 28 DAY
          GROUP BY query ORDER BY impressions DESC LIMIT 8`,
        [String(r.website_id), String(r.slug)]
      );
      const topQueries = (queryRows as any[]).map((q) => ({
        query: String(q.query),
        impressions: Number(q.impressions),
        avgPosition: Number(q.avgPosition),
      }));

      // Up to 2 attempts: a screen failure feeds its violations into a retry prompt.
      let humanized: BlogPostStructure | null = null;
      let violations: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = brandRealignPrompt({
          currentPost: sanitizeTopicMap(current),
          keyword: String(r.primary_keyword),
          topQueries,
          violations: violations.length > 0 ? violations : undefined,
          allowRetitle: retitle,
        });
        const raw = await gemini.generateText({
          systemInstruction: prompt.system, userPrompt: prompt.user, temperature: 0.5, maxOutputTokens: 8192,
        });
        const parsed = safeJsonParse(raw) as BlogPostStructure;
        if (!parsed?.title || !Array.isArray(parsed.sections)) throw new Error('invalid structure');

        const { post: humanizedCandidate } = postHumanizer.humanize(parsed);
        const { post: candidate, stats: redactionStats } = redactViolatingSentences(humanizedCandidate);
        if (redactionStats.droppedSentences.length > 0) {
          console.log(`  auto-redacted ${redactionStats.droppedSentences.length} sentence(s)`);
        }

        // Ranking safety pins — the URL never moves; the SERP title only moves in --retitle mode.
        candidate.slug = current.slug;
        if (!retitle) {
          candidate.title = current.title;
          if (candidate.meta && current.meta) candidate.meta.title = current.meta.title;
        }

        violations = screenBrandViolations(candidate, retitle);
        if (violations.length === 0) { humanized = candidate; break; }
        console.log(`  attempt ${attempt} rejected: ${violations.join('; ')}`);
      }
      if (!humanized) throw new Error(`brand screen failed twice: ${violations.join('; ')}`);

      if (retitle) {
        await mysqlPool.query<ResultSetHeader>(
          `UPDATE posts SET content_json = ?, title = ?, meta_title = ?, meta_description = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(humanized), humanized.title, humanized.meta?.title ?? humanized.title, humanized.meta?.description ?? '', String(r.id)]
        );
        console.log(`  retitled: "${String(r.slug)}"\n    old: "${String((typeof r.content_json === 'string' ? JSON.parse(r.content_json) : r.content_json).title).slice(0, 70)}"\n    new: "${humanized.title.slice(0, 70)}"`);
      } else {
        await mysqlPool.query<ResultSetHeader>(
          `UPDATE posts SET content_json = ?, meta_description = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(humanized), humanized.meta?.description ?? '', String(r.id)]
        );
      }

      try {
        const emb = await gemini.embedText(`${humanized.title}\n${humanized.meta?.description ?? ''}\n${humanized.hero?.hook ?? ''}`);
        await embeddings.upsert({ entityType: 'post', entityId: String(r.id), embedding: emb });
      } catch { /* re-embed best-effort */ }

      refreshed.push({
        websiteId: String(r.website_id),
        domain: String(r.domain),
        slug: String(r.slug),
        url: buildPostUrl(String(r.domain), String(r.slug)),
      });
      ok++;
      console.log(`✓ [${topQueries.length} GSC queries] "${String(current.title).slice(0, 64)}"`);
    } catch (e) {
      fail++;
      console.log(`✗ ${r.id}: ${e instanceof Error ? e.message.slice(0, 90) : String(e)}`);
    }
  }

  const indexNow = new IndexNowService();
  if (indexNow.isEnabled() && refreshed.length > 0) {
    const results = await indexNow.submitUrls(refreshed);
    for (const s of results) {
      console.log(`IndexNow ${s.ok ? 'OK' : 'FAILED'} — ${s.domain}: ${s.submitted} URLs${s.error ? ` (${s.error})` : ''}`);
    }
  } else if (!indexNow.isEnabled()) {
    console.log('IndexNow disabled (no INDEXNOW_KEY) — skipping ping.');
  }

  console.log(`\nRefreshed ${ok}, failed ${fail}. Slugs unchanged; ${retitle ? 'title rewritten to brand' : 'titles and meta titles unchanged'}; body aligned to brand voice.`);
  await mysqlPool.end();
  await postgresPool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
