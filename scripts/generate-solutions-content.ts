/**
 * GENERATE SOLUTIONS PAGE CONTENT — test runner for service x niche landing pages.
 * Each page is grounded in real DataForSEO keyword/SERP data (never AI-guessed
 * demand) plus the full brand voice + evidence inventory. Generation is skipped
 * (not faked) for any combo with zero real keyword volume.
 *
 *   npx tsx scripts/generate-solutions-content.ts          # default: 3 pending combos
 *   npx tsx scripts/generate-solutions-content.ts 5        # up to 5 pending combos
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { WebsiteService } from '../src/services/websiteService.js';
import { SolutionsService } from '../src/services/solutionsService.js';

const TARGET_DOMAIN = 'theabdulrehman.com';

async function main() {
  const limit = Number(process.argv[2] ?? 3);

  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  if (apiKeys.length === 0) throw new Error('No Gemini API keys configured');
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS
  });

  const websiteService = new WebsiteService(mysqlPool);
  const website = await websiteService.getByDomain(TARGET_DOMAIN);
  if (!website) throw new Error(`Website not found for domain ${TARGET_DOMAIN}`);

  const solutions = new SolutionsService({ pool: mysqlPool, gemini });

  const services = await solutions.listServices(website.id);
  const niches = await solutions.listNiches(website.id);
  console.log(`Website: ${website.domain} — ${services.length} services x ${niches.length} approved niches = ${services.length * niches.length} possible pages`);

  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    console.log('⚠️  DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are not set — every combo will be skipped (no real keyword data to ground on).');
  }

  console.log(`Generating up to ${limit} pending solutions page(s)…\n`);
  const generated = await solutions.generatePendingSolutions(website.id, limit);
  console.log(`\n✓ Generated: ${generated}/${limit} requested`);

  const [rows]: any = await mysqlPool.query(
    `SELECT sol.headline, sol.subheadline, sol.meta_title, sol.meta_description, sol.cta_text,
            sol.pain_points_json, sol.approach_json, sol.proof_points_json, sol.faq_json,
            sol.target_keywords_json, s.name AS service_name, n.name AS niche_name
       FROM solutions sol
       JOIN services s ON s.id = sol.service_id
       JOIN niches n ON n.id = sol.niche_id
      WHERE sol.website_id = ?
      ORDER BY sol.content_generated_at DESC
      LIMIT ?`,
    [website.id, limit]
  );

  for (const row of rows as any[]) {
    console.log('\n' + '='.repeat(70));
    console.log(`${row.service_name} x ${row.niche_name}`);
    console.log('='.repeat(70));
    console.log(`HEADLINE: ${row.headline}`);
    console.log(`SUBHEADLINE: ${row.subheadline}`);
    console.log(`META: ${row.meta_title} | ${row.meta_description}`);
    console.log(`\nPAIN POINTS:`);
    for (const p of row.pain_points_json ?? []) console.log(`  - ${p}`);
    console.log(`\nAPPROACH:`);
    for (const a of row.approach_json ?? []) console.log(`  - ${a.step}: ${a.description}`);
    console.log(`\nPROOF POINTS:`);
    for (const p of row.proof_points_json ?? []) console.log(`  - ${p}`);
    console.log(`\nFAQ:`);
    for (const f of row.faq_json ?? []) console.log(`  Q: ${f.question}\n  A: ${f.answer}`);
    console.log(`\nCTA: ${row.cta_text}`);
    const onPage = row.target_keywords_json?.onPageCandidates ?? [];
    console.log(`\nON-PAGE KEYWORD TARGET(S) (safe to feature verbatim, ${onPage.length ? 'used above' : 'none — page relies on internal links, not standalone ranking'}):`);
    for (const k of onPage) console.log(`  - "${k.keyword}" vol=${k.volume} cpc=${k.cpc} difficulty=${k.difficulty}`);
    console.log(`\nMARKET SIGNAL (context only, not targeted verbatim):`);
    for (const k of row.target_keywords_json?.marketSignal ?? []) {
      console.log(`  - "${k.keyword}" vol=${k.volume} cpc=${k.cpc} difficulty=${k.difficulty}`);
    }
  }

  await mysqlPool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch {}
  process.exit(1);
});
