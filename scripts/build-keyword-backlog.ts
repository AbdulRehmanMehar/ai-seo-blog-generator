/**
 * BUILD KEYWORD BACKLOG — a clean, freshly DataForSEO-verified, persisted pool
 * of real buyer keywords not yet claimed by any post. Never trusts the shared
 * `keywords` MySQL table's stored volume/cpc (it's contaminated with months of
 * old Gemini-fabricated estimates mixed into genuinely real DataForSEO rows,
 * with no reliable way to tell them apart after the fact). Every number here
 * comes from a DataForSEO call made in THIS run.
 *
 *   npx tsx scripts/build-keyword-backlog.ts
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { KeywordService } from '../src/services/keywordService.js';
import { getBrandKnowledge } from '../src/knowledge/brandKnowledge.js';

async function main() {
  const svc = new KeywordService({ pool: mysqlPool, gemini: null as any });
  if (!svc.dataForSeoEnabled()) throw new Error('DataForSEO credentials missing');

  const b = getBrandKnowledge();
  const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const SEEDS = [
    ...b.target_market.sweet_spot_problems,
    'online booking system for small business', 'appointment scheduling software for clinics',
    'workflow automation for small business', 'client intake automation', 'ai assistant for small business',
    'custom crm for real estate agents', 'connect crm to scheduling software', 'custom software for growing business',
    'field service management software', 'recruiting agency automation software', 'job board development',
    'inventory management for small retailer', 'property management software for landlords',
    'restaurant reservation system', 'gym management software', 'spa booking software', 'dental practice software',
    'ecommerce site speed optimization', 'website redesign for growing business', 'mvp development for startup founder',
    'rebuild app after bad development experience', 'developer disappeared mid project',
    'how to choose a software development partner', 'fixed price vs hourly software development',
    'custom dashboard for business owners', 'document automation software', 'automate appointment reminders',
    'customer onboarding software', 'quoting software for contractors', 'course booking system',
    'crm for service business', 'automate follow up emails', 'excel to web app', 'replace excel with database',
  ].map(sanitize).filter((s) => s.length >= 3 && s.length <= 80 && s.split(' ').length <= 10);
  const uniqueSeeds = [...new Set(SEEDS)];
  console.log(`Discovering from ${uniqueSeeds.length} brand-native seeds...`);

  const ideas = await (svc as any).dataForSeoKeywordsForKeywords(uniqueSeeds) as Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }>;
  console.log(`Raw ideas: ${ideas.length}`);

  const [claimedRows] = await mysqlPool.query<any>(
    `SELECT DISTINCT LOWER(TRIM(primary_keyword)) AS kw FROM posts WHERE status='published' AND primary_keyword IS NOT NULL`
  );
  const claimed = new Set((claimedRows as any[]).map((r: any) => r.kw));

  const seen = new Set<string>();
  const backlog = ideas
    .map((i) => ({ ...i, keyword: i.keyword.toLowerCase() }))
    .filter((i) => (i.volume ?? 0) >= 50 && (i.difficulty ?? 100) <= 65 && !claimed.has(i.keyword))
    .filter((i) => (seen.has(i.keyword) ? false : (seen.add(i.keyword), true)))
    .sort((a, b) => (b.cpc ?? 0) - (a.cpc ?? 0));

  console.log(`Fresh, real, unclaimed backlog: ${backlog.length}`);
  for (const k of backlog.slice(0, 30)) console.log(`  ${k.volume}/mo | $${k.cpc ?? '?'} | diff ${k.difficulty} | ${k.keyword}`);

  fs.writeFileSync('review/verified-keyword-backlog.json', JSON.stringify({ generatedAt: 'fresh-dataforseo-run', backlog }, null, 2));
  console.log(`\nWritten: review/verified-keyword-backlog.json (${backlog.length} entries)`);
  await mysqlPool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
