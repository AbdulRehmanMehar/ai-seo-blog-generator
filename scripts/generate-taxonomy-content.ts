/**
 * GENERATE TAXONOMY PAGE CONTENT — unique seo_content + meta for category/tag hub pages
 * (LLM, grounded in each hub's actual posts). Categories are generated first, then
 * indexable tags, up to `limit` total. Throttled by the LLM rate limiter / daily cap.
 *
 *   npx tsx scripts/generate-taxonomy-content.ts          # default 20 (≈ all categories)
 *   npx tsx scripts/generate-taxonomy-content.ts 120      # categories + tags
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { TaxonomyService } from '../src/services/taxonomyService.js';

async function main() {
  const limit = Number(process.argv[2] ?? 20);
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  if (apiKeys.length === 0) throw new Error('No Gemini API keys configured');
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });

  console.log(`Generating hub-page content (limit ${limit}); categories first, then indexable tags…`);
  const taxonomy = new TaxonomyService({ pool: mysqlPool, gemini });
  const res = await taxonomy.generatePendingPageContent(limit);
  console.log(`✓ Generated: categories=${res.categories}, tags=${res.tags}`);

  const [cat]: any = await mysqlPool.query(
    `SELECT COUNT(*) total, SUM(seo_content IS NOT NULL) done FROM categories WHERE post_count>0`
  );
  const [tag]: any = await mysqlPool.query(
    `SELECT COUNT(*) total, SUM(seo_content IS NOT NULL) done FROM tags WHERE is_indexable=1`
  );
  console.log(`Categories with content: ${cat[0].done}/${cat[0].total} | Indexable tags with content: ${tag[0].done}/${tag[0].total}`);
  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
