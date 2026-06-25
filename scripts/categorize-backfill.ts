/**
 * CATEGORIZE BACKFILL — assign every published post to a category via embedding similarity
 * (no per-post LLM), link each post to its category hub, recompute counts, refresh sitemap.
 *
 * Only ~20 embedding calls total (one per seeded category), so it respects the LLM cap.
 *
 * Run: npx tsx scripts/categorize-backfill.ts
 *
 * Frontend still needs /blog/category/[slug] routes to render these (see prior notes).
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { CategorizationService } from '../src/services/categorizationService.js';
import { TaxonomyService } from '../src/services/taxonomyService.js';
import { SitemapService } from '../src/services/sitemapService.js';

async function main() {
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  if (apiKeys.length === 0) throw new Error('No Gemini API keys configured');
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });

  console.log('STEP 1: Categorizing posts by embedding similarity (embedding categories first)…');
  const svc = new CategorizationService({ mysql: mysqlPool, postgres: postgresPool, gemini });
  const res = await svc.categorizeAll({ maxPerPost: 2 });
  console.log(`   ✓ Embedded ${res.categoriesEmbedded} categories`);
  console.log(`   ✓ Categorized ${res.categorized} posts (${res.assignments} category assignments, ≤2 each)`);

  console.log('\nSTEP 2: Recomputing category/tag counts + indexability…');
  const taxonomy = new TaxonomyService({ pool: mysqlPool, gemini });
  const counts = await taxonomy.recomputeCountsAndIndexability();
  const [catSummary] = await mysqlPool.query<any[]>(
    `SELECT w.domain, COUNT(*) total, SUM(c.post_count>0) with_posts
       FROM categories c JOIN websites w ON w.id=c.website_id GROUP BY w.domain`
  );
  for (const r of catSummary as any[]) console.log(`   ${r.domain}: ${r.with_posts}/${r.total} categories now have posts`);

  console.log('\nSTEP 3: Regenerating sitemaps (now include category hub pages)…');
  const sitemap = new SitemapService(mysqlPool);
  const maps = await sitemap.generateAll();
  for (const m of maps) console.log(`   ✓ ${m.filePath} (${m.urlCount} URLs for ${m.domain})`);

  console.log('\n✅ Categorization backfill complete.');
  console.log('   Posts now belong to categories and link to their category hub.');
  console.log('   Build /blog/category/[slug] routes (render seo_content + post list) to expose them.');

  await mysqlPool.end();
  await postgresPool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
