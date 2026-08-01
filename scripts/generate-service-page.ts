/**
 * GENERATE SERVICE PAGE — the service-level solutions page (/solutions/{serviceSlug}),
 * the primary standalone sales page of the solutions architecture. Draws proof from
 * every niche with matched case studies (case_studies.json niche_fit). Costs Gemini
 * calls only — never touches DataForSEO.
 *
 * Refuses to touch an already-published or human-reviewed page unless --force is
 * passed; with --force, the page re-enters the review queue (page_status resets to
 * draft, reviewed_by/reviewed_at clear).
 *
 *   npx tsx scripts/generate-service-page.ts booking-scheduling-intake
 *   npx tsx scripts/generate-service-page.ts booking-scheduling-intake --force
 *   npx tsx scripts/generate-service-page.ts --all            (every service without a page yet)
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { SolutionsService } from '../src/services/solutionsService.js';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const all = args.includes('--all');
  const [serviceSlug] = args.filter((a) => !a.startsWith('--'));
  if (!serviceSlug && !all) {
    console.error('Usage: npx tsx scripts/generate-service-page.ts <service-slug> [--force] | --all');
    process.exit(1);
  }

  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  if (apiKeys.length === 0) throw new Error('No Gemini API keys configured');
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS
  });
  const solutions = new SolutionsService({ pool: mysqlPool, gemini });

  let targets: Array<{ id: string; slug: string }>;
  if (all) {
    const [rows]: any = await mysqlPool.query(
      `SELECT id, slug FROM services WHERE content_json IS NULL ORDER BY name`
    );
    targets = rows;
    if (targets.length === 0) console.log('Every service already has page content. Use a slug + --force to regenerate one.');
  } else {
    const [[row]]: any = await mysqlPool.query(`SELECT id, slug FROM services WHERE slug = ?`, [serviceSlug]);
    if (!row) throw new Error(`No service found with slug ${serviceSlug}`);
    targets = [row];
  }

  for (const t of targets) {
    console.log(`\n=== ${t.slug} ===`);
    const ok = await solutions.generateServicePage(t.id, { force });
    console.log(ok ? `Generated service page for ${t.slug} (passed AI review).` : `Did not cleanly generate ${t.slug} — see log above (may still be stored as draft for review).`);
  }

  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
