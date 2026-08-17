/**
 * FULL-CORPUS BRAND REALIGN — every published post gets the complete brand
 * voice rewrite (friction-first framing, evidence-only claims, "what working
 * with me looks like" for service-intent keywords), not just the deterministic
 * redaction sweep. Phase A (corpus-redact.ts) only stripped violations; this
 * is the actual rewrite pass on top of that.
 *
 * Runs over ALL published posts (any index_state), oldest-updated first, so
 * re-running always continues where the last run stopped. Posts touched in
 * the last 2 days (Wave 1/2 purpose-built pages) are skipped — they already
 * got this treatment with keyword retargeting on top.
 *
 * Titles/slugs are ALWAYS pinned here — this is a voice pass, not a keyword
 * campaign, so there is zero reason to risk any existing ranking. The 26
 * posts with brand-violating titles (review/redaction/_title-violations.md)
 * are handled separately, deliberately, with --retitle on brand-refresh-indexed.ts.
 *
 *   npx tsx scripts/brand-realign-corpus.ts            # runs until the corpus is done
 *   npx tsx scripts/brand-realign-corpus.ts 50         # cap this run to 50 posts
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
import { IndexNowService } from '../src/services/indexNowService.js';
import { safeJsonParse } from '../src/utils/json.js';
import type { BlogPostStructure } from '../src/prompts/blogGeneration.js';
import { sanitizeTopicMap, redactViolatingSentences, screenBrandViolations } from '../src/services/brandRedaction.js';

// Purpose-built pages (Wave 1 + repurposes + Wave 2) already got the full
// realign WITH keyword retargeting — skip them here by slug, not by
// updated_at, because Phase A's corpus-wide redaction bumped updated_at on
// nearly every post and would otherwise hide the whole corpus from this run.
const ALREADY_REALIGNED_SLUGS = [
  'luxury-website-performance-killers',
  'shipping-digital-products-that-grow-fast',
  'hidden-500k-cost-bad-software-partnership',
  'your-30-year-legacy-system-is-a-5m-maintenance-trap',
  'virtual-cto-bespoke-ai-real-estate',
  'property-directors-off-the-shelf-software-mistake',
  'build-saas-without-technical-debt',
  'code-traps-killing-system-future-deep-review',
  'why-custom-software-budget-explodes-accurate-estimates',
  'property-software-costs-millions-asset-value',
  'why-off-the-shelf-workflow-software-fails-service-business',
  '5-mistakes-hiring-fractional-cto',
  'pre-exit-code-review-due-diligence-fail',
  'due-diligence-api-first-saas-exit',
  'your-off-the-shelf-crm-is-slowing-you-down',
  'how-to-choose-custom-crm-software-development-company',
  'why-your-field-service-app-creates-more-work',
];

async function main() {
  const limit = Number(process.argv[2] ?? 100000);
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  const gemini = new GeminiClient({
    rateLimiter: new GeminiRateLimiter(mysqlPool, apiKeys),
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_PROVIDER === 'openrouter' ? 0 : env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
  const embeddings = new EmbeddingStore(postgresPool);

  const placeholders = ALREADY_REALIGNED_SLUGS.map(() => '?').join(',');
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT p.id, p.slug, p.primary_keyword, p.content_json, p.website_id, w.domain
       FROM posts p JOIN websites w ON w.id = p.website_id
      WHERE p.status = 'published'
        AND p.slug NOT IN (${placeholders})
      ORDER BY p.updated_at ASC
      LIMIT ?`,
    [...ALREADY_REALIGNED_SLUGS, limit]
  );
  console.log(`Full-corpus brand realign via ${env.LLM_PROVIDER === 'openrouter' ? env.OPENROUTER_MODEL : env.GEMINI_GENERATION_MODEL} | posts this run: ${(rows as any[]).length}\n`);

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
        query: String(q.query), impressions: Number(q.impressions), avgPosition: Number(q.avgPosition),
      }));

      let humanized: BlogPostStructure | null = null;
      let violations: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = brandRealignPrompt({
          currentPost: sanitizeTopicMap(current),
          keyword: String(r.primary_keyword ?? current.title),
          topQueries,
          violations: violations.length > 0 ? violations : undefined,
          allowRetitle: false,
        });
        const raw = await gemini.generateText({
          systemInstruction: prompt.system, userPrompt: prompt.user, temperature: 0.5, maxOutputTokens: 8192,
        });
        const parsed = safeJsonParse(raw) as BlogPostStructure;
        if (!parsed?.title || !Array.isArray(parsed.sections)) throw new Error('invalid structure');

        const { post: humanizedCandidate } = postHumanizer.humanize(parsed);
        const { post: candidate, stats } = redactViolatingSentences(humanizedCandidate);
        if (stats.droppedSentences.length > 0) console.log(`  auto-redacted ${stats.droppedSentences.length} sentence(s)`);

        // Titles and slugs are ALWAYS pinned in this pass — voice only, zero ranking risk.
        candidate.slug = current.slug;
        candidate.title = current.title;
        if (candidate.meta && current.meta) candidate.meta.title = current.meta.title;

        violations = screenBrandViolations(candidate, false);
        if (violations.length === 0) { humanized = candidate; break; }
        console.log(`  attempt ${attempt} rejected: ${violations.join('; ')}`);
      }
      if (!humanized) throw new Error(`brand screen failed twice: ${violations.join('; ')}`);

      await mysqlPool.query<ResultSetHeader>(
        `UPDATE posts SET content_json = ?, meta_description = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(humanized), humanized.meta?.description ?? '', String(r.id)]
      );

      try {
        const emb = await gemini.embedText(`${humanized.title}\n${humanized.meta?.description ?? ''}\n${humanized.hero?.hook ?? ''}`);
        await embeddings.upsert({ entityType: 'post', entityId: String(r.id), embedding: emb });
      } catch { /* re-embed best-effort */ }

      refreshed.push({ websiteId: String(r.website_id), domain: String(r.domain), slug: String(r.slug), url: buildPostUrl(String(r.domain), String(r.slug)) });
      ok++;
      console.log(`✓ (${ok}/${(rows as any[]).length}) [${r.domain}] "${String(current.title).slice(0, 60)}"`);
    } catch (e) {
      fail++;
      console.log(`✗ ${r.id}: ${e instanceof Error ? e.message.slice(0, 90) : String(e)}`);
    }

    // Ping IndexNow every 50 to spread discovery instead of one giant batch at the end.
    if (refreshed.length > 0 && refreshed.length % 50 === 0) {
      const indexNow = new IndexNowService();
      if (indexNow.isEnabled()) {
        const batch = refreshed.splice(0, refreshed.length);
        const results = await indexNow.submitUrls(batch);
        for (const s of results) console.log(`  IndexNow ${s.ok ? 'OK' : 'FAILED'} — ${s.domain}: ${s.submitted} URLs`);
      }
    }
  }

  const indexNow = new IndexNowService();
  if (indexNow.isEnabled() && refreshed.length > 0) {
    const results = await indexNow.submitUrls(refreshed);
    for (const s of results) console.log(`IndexNow ${s.ok ? 'OK' : 'FAILED'} — ${s.domain}: ${s.submitted} URLs`);
  }

  console.log(`\nRealigned ${ok}, failed ${fail}. Titles and slugs unchanged; body fully rewritten to brand voice.`);
  await mysqlPool.end();
  await postgresPool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
