/**
 * APPROVE SOLUTION — human sign-off on one solutions page. Sets reviewed_by/reviewed_at
 * (the one real gate publish-solutions.ts checks) and recomputes+upserts its embedding,
 * so an overridden exhausted-quality-gate row enters the near-duplicate corpus now that
 * a human has vouched for it.
 *
 *   npx tsx scripts/approve-solution.ts booking-scheduling-intake recruiting-staffing "Abdul Rehman"
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

async function main() {
  const [serviceSlug, nicheSlug, reviewerName] = process.argv.slice(2);
  if (!serviceSlug || !nicheSlug || !reviewerName) {
    console.error('Usage: npx tsx scripts/approve-solution.ts <service-slug> <niche-slug> "<reviewer name>"');
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

  const [[row]]: any = await mysqlPool.query(
    `SELECT sol.id FROM solutions sol
       JOIN services s ON s.id = sol.service_id
       JOIN niches n ON n.id = sol.niche_id
      WHERE s.slug = ? AND n.slug = ?`,
    [serviceSlug, nicheSlug]
  );
  if (!row) throw new Error(`No solutions row found for ${serviceSlug} x ${nicheSlug}`);

  const solutions = new SolutionsService({ pool: mysqlPool, gemini });
  const ok = await solutions.approveSolution(row.id, reviewerName);
  console.log(ok ? `Approved ${serviceSlug} x ${nicheSlug} as reviewed by "${reviewerName}".` : 'Approval failed.');

  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
