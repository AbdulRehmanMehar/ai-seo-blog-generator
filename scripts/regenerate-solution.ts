/**
 * REGENERATE SOLUTION — calls generateSolutionContent directly for one service x niche
 * pair, bypassing generatePendingSolutions' NOT EXISTS filter (which would otherwise
 * permanently skip any pair that already has a row — including exhausted-quality-gate
 * rows sitting in the review queue with nothing else able to retry them). Without this
 * script, the review queue is a dead end for anything except approve-as-is or discard.
 *
 * Refuses to touch an already-published or human-reviewed row unless --force is passed
 * (see generateSolutionContent's regeneration guard) — with --force, the row re-enters
 * the review queue (status resets to draft, reviewed_by/reviewed_at clear).
 *
 *   npx tsx scripts/regenerate-solution.ts booking-scheduling-intake hospitality
 *   npx tsx scripts/regenerate-solution.ts booking-scheduling-intake hospitality --force
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
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
  const [serviceSlug, nicheSlug] = args.filter((a) => a !== '--force');
  if (!serviceSlug || !nicheSlug) {
    console.error('Usage: npx tsx scripts/regenerate-solution.ts <service-slug> <niche-slug> [--force]');
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

  const [[serviceRow]]: any = await mysqlPool.query(`SELECT id FROM services WHERE slug = ?`, [serviceSlug]);
  const [[nicheRow]]: any = await mysqlPool.query(`SELECT id FROM niches WHERE slug = ?`, [nicheSlug]);
  if (!serviceRow) throw new Error(`No service found with slug ${serviceSlug}`);
  if (!nicheRow) throw new Error(`No niche found with slug ${nicheSlug}`);

  const solutions = new SolutionsService({ pool: mysqlPool, gemini });
  const ok = await solutions.generateSolutionContent(serviceRow.id, nicheRow.id, { force });
  console.log(ok ? `Regenerated ${serviceSlug} x ${nicheSlug}.` : 'Regeneration did not produce a stored page — see log above.');

  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
