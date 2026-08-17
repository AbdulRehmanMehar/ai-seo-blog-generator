/**
 * EXECUTE THE REMAP PLAN — approved 2026-07-26.
 *
 * 1. MERGES: every duplicate whose keyword assignment did NOT survive research-agent
 *    validation 301s into its same-topic canonical (chain-safe via ConsolidationService).
 * 2. The 3 validated repurpose slugs are excluded here — they get retargeted and
 *    realigned through the Wave-1 machinery separately.
 * 3. Sitemaps regenerate (merged posts drop out) and IndexNow gets the OLD urls so
 *    crawlers discover the 301s fast.
 *
 *   npx tsx scripts/execute-remap.ts --dry     # counts only
 *   npx tsx scripts/execute-remap.ts --apply
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs';
import path from 'node:path';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { ConsolidationService } from '../src/services/consolidationService.js';
import { SitemapService, buildPostUrl, type PublishedPostUrl } from '../src/services/sitemapService.js';
import { IndexNowService } from '../src/services/indexNowService.js';

const VALIDATED_REPURPOSE_SLUGS = new Set([
  '5-mistakes-hiring-fractional-cto',
  'pre-exit-code-review-due-diligence-fail',
  'due-diligence-api-first-saas-exit',
]);

async function main() {
  const apply = process.argv.includes('--apply');
  const plan = JSON.parse(fs.readFileSync(path.resolve('review/remap-plan.json'), 'utf8'));
  const bySlug = new Map<string, any>((plan.duplicates as any[]).map((d) => [d.slug, d]));

  const toMerge: any[] = [];
  for (const decision of plan.decisions as any[]) {
    if (VALIDATED_REPURPOSE_SLUGS.has(decision.slug)) continue;
    const dup = bySlug.get(decision.slug);
    if (!dup) { console.log(`⚠️ no duplicate entry for ${decision.slug}`); continue; }
    toMerge.push(dup);
  }
  console.log(`Merges to execute: ${toMerge.length} | validated repurposes excluded: ${VALIDATED_REPURPOSE_SLUGS.size}`);
  if (!apply) {
    for (const d of toMerge.slice(0, 8)) console.log(`  /${d.slug} → 301 → /${d.canonicalSlug}`);
    console.log(`  ... (dry run — pass --apply to execute)`);
    await mysqlPool.end();
    process.exit(0);
  }

  const consolidation = new ConsolidationService({ mysql: mysqlPool, postgres: postgresPool });
  let merged = 0, failed = 0;
  const oldUrls: PublishedPostUrl[] = [];
  for (const d of toMerge) {
    try {
      const ok = await consolidation.markMerged(d.id, d.slug, d.canonicalSlug);
      if (ok) {
        merged++;
        oldUrls.push({ websiteId: d.websiteId, domain: d.domain, slug: d.slug, url: buildPostUrl(d.domain, d.slug) });
      } else failed++;
    } catch (e) {
      failed++;
      console.log(`✗ ${d.slug}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
    }
  }
  const chainsFixed = await consolidation.flattenRedirects();

  const sitemaps = await new SitemapService(mysqlPool).generateAll();
  for (const s of sitemaps) console.log(`sitemap: ${JSON.stringify(s)}`);

  const indexNow = new IndexNowService();
  if (indexNow.isEnabled() && oldUrls.length > 0) {
    const results = await indexNow.submitUrls(oldUrls);
    for (const s of results) console.log(`IndexNow ${s.ok ? 'OK' : 'FAILED'} — ${s.domain}: ${s.submitted} URLs`);
  }

  console.log(`\n══ MERGES APPLIED ══`);
  console.log(`merged: ${merged} | failed: ${failed} | redirect chains flattened: ${chainsFixed}`);
  await mysqlPool.end();
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
