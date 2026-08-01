/**
 * LIST SOLUTIONS FOR REVIEW — the human review queue: every draft solutions page,
 * worst-first (failed/low-scoring AI review first) so a human triages failures before
 * skimming the ones that already look fine.
 *
 *   npx tsx scripts/list-solutions-for-review.ts
 *   npx tsx scripts/list-solutions-for-review.ts primestrides.com
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { mysqlPool } from '../src/db/mysqlPool.js';
import { WebsiteService } from '../src/services/websiteService.js';
import { SolutionsService } from '../src/services/solutionsService.js';
import type { GeminiClient } from '../src/llm/geminiClient.js';

const TARGET_DOMAIN = process.argv[2] ?? 'theabdulrehman.com';

async function main() {
  const websiteService = new WebsiteService(mysqlPool);
  const website = await websiteService.getByDomain(TARGET_DOMAIN);
  if (!website) throw new Error(`Website not found for domain ${TARGET_DOMAIN}`);

  // Listing never generates or embeds, so no real GeminiClient is needed here.
  const solutions = new SolutionsService({ pool: mysqlPool, gemini: null as unknown as GeminiClient });
  const rows = await solutions.listForReview(website.id);

  if (rows.length === 0) {
    console.log(`No draft solutions pages awaiting review for ${TARGET_DOMAIN}.`);
  } else {
    console.log(`${rows.length} draft solutions page(s) for ${TARGET_DOMAIN}, worst-first:\n`);
    for (const r of rows) {
      const status = r.aiReviewPassed === null ? 'not yet reviewed' : r.aiReviewPassed ? 'passed' : 'FAILED';
      console.log(`[${r.serviceSlug} x ${r.nicheSlug}] score=${r.aiReviewScore ?? 'n/a'} (${status}) words=${r.wordCount} reviewed_by=${r.reviewedBy ?? '(none)'}`);
      console.log(`  ${r.headline}`);
    }
    console.log(`\nApprove: npx tsx scripts/approve-solution.ts <service-slug> <niche-slug> "<your name>"`);
    console.log(`Regenerate: npx tsx scripts/regenerate-solution.ts <service-slug> <niche-slug> [--force]`);
  }

  const servicePages = await solutions.listServicePagesForReview(website.id);
  if (servicePages.length > 0) {
    console.log(`\n${servicePages.length} draft SERVICE-LEVEL page(s) for ${TARGET_DOMAIN}, worst-first:\n`);
    for (const p of servicePages) {
      const status = p.aiReviewPassed === null ? 'not yet reviewed' : p.aiReviewPassed ? 'passed' : 'FAILED';
      console.log(`[${p.slug}] score=${p.aiReviewScore ?? 'n/a'} (${status}) words=${p.wordCount} reviewed_by=${p.reviewedBy ?? '(none)'}`);
    }
    console.log(`\nApprove: npx tsx scripts/approve-service-page.ts <service-slug> "<your name>"`);
    console.log(`Publish: npx tsx scripts/publish-service-page.ts <service-slug>`);
  }

  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
