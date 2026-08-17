/**
 * APPROVE SERVICE PAGE — human sign-off on a service-level page draft.
 *
 *   npx tsx scripts/approve-service-page.ts booking-scheduling-intake "Abdul Rehman"
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { mysqlPool } from '../src/db/mysqlPool.js';
import { SolutionsService } from '../src/services/solutionsService.js';
import type { GeminiClient } from '../src/llm/geminiClient.js';

async function main() {
  const [serviceSlug, reviewedBy] = process.argv.slice(2);
  if (!serviceSlug || !reviewedBy) {
    console.error('Usage: npx tsx scripts/approve-service-page.ts <service-slug> "<reviewer name>"');
    process.exit(1);
  }

  const [[row]]: any = await mysqlPool.query(`SELECT id FROM services WHERE slug = ?`, [serviceSlug]);
  if (!row) throw new Error(`No service found with slug ${serviceSlug}`);

  // Approval never generates content — no Gemini client needed.
  const solutions = new SolutionsService({ pool: mysqlPool, gemini: null as unknown as GeminiClient });
  const ok = await solutions.approveServicePage(row.id, reviewedBy);
  console.log(ok ? `Approved service page ${serviceSlug} (reviewed by ${reviewedBy}). Publish with publish-service-pages.ts.` : `Could not approve ${serviceSlug} — no generated content yet?`);

  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
