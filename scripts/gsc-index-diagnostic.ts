/**
 * GSC INDEXING DIAGNOSTIC (read-only)
 *
 * For each GSC-configured website this script:
 *   1. Pulls the top search queries by impressions (last 28 days).
 *   2. Pulls the pages that received impressions (these are definitely indexed).
 *   3. Loads published posts from the DB and matches them to GSC pages by slug.
 *   4. Splits posts into "getting impressions" vs "zero impressions".
 *   5. Runs the URL Inspection API on a sample of each cohort to get the real
 *      Google coverage state (Submitted and indexed / Crawled - currently not
 *      indexed / Discovered - currently not indexed / URL unknown to Google).
 *
 * Goal: compare indexed vs not-indexed posts to understand why Google stopped
 * indexing new content. Nothing is written — this only reads GSC + the DB.
 *
 * Run: npx tsx scripts/gsc-index-diagnostic.ts
 */
import 'dotenv/config';
import dns from 'node:dns';
// This host has broken IPv6 egress, but Google endpoints resolve to IPv6 first and
// google-auth's node-fetch client hangs on it (ETIMEDOUT) instead of falling back to
// IPv4 like curl does. setDefaultResultOrder is ignored by node-fetch, so force IPv4 at
// the source by intercepting dns.lookup for every connection.
dns.setDefaultResultOrder('ipv4first');
const _origLookup = dns.lookup;
(dns as any).lookup = function (hostname: string, options: any, callback: any) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  opts.family = 4;
  return (_origLookup as any)(hostname, opts, callback);
};
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { buildGscClient } from '../src/services/gscClient.js';

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => fmt(new Date(Date.now() - n * 86_400_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How many posts from each cohort to inspect via the (rate-limited) URL Inspection API.
const ZERO_IMPR_SAMPLE = Number(process.env.DIAG_ZERO_SAMPLE ?? 18);
const WITH_IMPR_SAMPLE = Number(process.env.DIAG_WITH_SAMPLE ?? 5);
const INSPECT_DELAY_MS = 800; // stay under URL Inspection QPS limits

async function inspectCohort(
  client: NonNullable<ReturnType<typeof buildGscClient>>,
  siteUrl: string,
  base: string,
  posts: Array<{ slug: string }>,
  limit: number,
  label: string
): Promise<Record<string, number>> {
  const verdicts: Record<string, number> = {};
  const n = Math.min(limit, posts.length);
  if (n === 0) return verdicts;
  console.log(`\n  Inspecting ${n} ${label} post(s):`);
  for (let i = 0; i < n; i++) {
    const url = base + posts[i]!.slug;
    try {
      const r = await client.inspectUrl(siteUrl, url);
      const key = r.coverageState || r.indexingState || 'UNKNOWN';
      verdicts[key] = (verdicts[key] ?? 0) + 1;
      console.log(`    [${r.indexingState}] ${r.coverageState ?? ''}  ${url}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      verdicts['INSPECT_ERROR'] = (verdicts['INSPECT_ERROR'] ?? 0) + 1;
      console.log(`    ERROR (${m.slice(0, 90)})  ${url}`);
    }
    await sleep(INSPECT_DELAY_MS);
  }
  return verdicts;
}

async function main() {
  const client = buildGscClient();
  if (!client) {
    console.error('❌ GSC OAuth not configured (need GSC_CLIENT_ID/SECRET/REFRESH_TOKEN in .env).');
    process.exit(1);
  }

  const [sites] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, domain, gsc_property_uri FROM websites
      WHERE is_active = 1 AND gsc_property_uri IS NOT NULL`
  );
  if ((sites as any[]).length === 0) {
    console.log('No active websites with gsc_property_uri configured.');
    await mysqlPool.end();
    return;
  }

  const startDate = daysAgo(28);
  const endDate = daysAgo(2); // GSC finalizes data with ~1-2 day lag

  for (const site of sites as any[]) {
    console.log('\n' + '═'.repeat(78));
    console.log(`SITE: ${site.domain}   (${site.gsc_property_uri})   window ${startDate} → ${endDate}`);
    console.log('═'.repeat(78));

    // 1) Top queries by impressions
    let queries: Awaited<ReturnType<typeof client.queryPerformance>> = [];
    try {
      queries = await client.queryPerformance({
        siteUrl: site.gsc_property_uri, startDate, endDate, dimensions: ['query'], rowLimit: 1000,
      });
    } catch (e) {
      console.log(`  ⚠️ query fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    queries.sort((a, b) => b.impressions - a.impressions);
    const totalImpr = queries.reduce((s, q) => s + q.impressions, 0);
    const totalClicks = queries.reduce((s, q) => s + q.clicks, 0);
    console.log(`\n📊 Queries with impressions: ${queries.length} | total impressions ${totalImpr} | total clicks ${totalClicks}`);
    console.log('   Top queries by impressions:');
    for (const q of queries.slice(0, 25)) {
      console.log(`     ${String(q.impressions).padStart(5)} impr | ${String(q.clicks).padStart(3)} clk | pos ${q.position.toFixed(1).padStart(5)} | "${q.query}"`);
    }

    // 2) Pages receiving impressions (definitely indexed)
    let pages: Awaited<ReturnType<typeof client.queryPerformance>> = [];
    try {
      pages = await client.queryPerformance({
        siteUrl: site.gsc_property_uri, startDate, endDate, dimensions: ['page'], rowLimit: 5000,
      });
    } catch (e) {
      console.log(`  ⚠️ page fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    pages.sort((a, b) => b.impressions - a.impressions);
    console.log(`\n📄 Pages receiving impressions: ${pages.length}`);
    for (const p of pages.slice(0, 10)) {
      console.log(`     ${String(p.impressions).padStart(5)} impr | ${String(p.clicks).padStart(3)} clk | ${p.page}`);
    }

    // slug → page lookup from GSC's own (real) URLs
    const slugToPage = new Map<string, string>();
    for (const p of pages) {
      try {
        const segs = new URL(p.page).pathname.split('/').filter(Boolean);
        const last = segs[segs.length - 1]?.toLowerCase();
        if (last) slugToPage.set(last, p.page);
      } catch { /* skip */ }
    }

    // 3) Published posts from DB
    const [postRows] = await mysqlPool.query<RowDataPacket[]>(
      `SELECT slug, title, created_at FROM posts
        WHERE website_id = ? AND status = 'published' AND slug IS NOT NULL
        ORDER BY created_at DESC`,
      [site.id]
    );
    const posts = (postRows as any[]).map((p) => ({ slug: String(p.slug).toLowerCase(), title: String(p.title), created_at: p.created_at }));
    console.log(`\n📚 Published posts in DB: ${posts.length}`);

    // Infer the real post URL base from a matched GSC page (ground truth), else fall back.
    let base: string | null = null;
    for (const post of posts) {
      const page = slugToPage.get(post.slug);
      if (page) {
        const u = new URL(page);
        const idx = u.pathname.toLowerCase().lastIndexOf(post.slug);
        base = u.origin + u.pathname.slice(0, idx);
        break;
      }
    }
    if (!base) base = `https://${site.domain}/blog/`;
    console.log(`   Inferred post URL base: ${base}`);

    // 4) Split posts by impressions
    const withImpr = posts.filter((p) => slugToPage.has(p.slug));
    const zeroImpr = posts.filter((p) => !slugToPage.has(p.slug));
    console.log(`   ✅ Posts getting impressions: ${withImpr.length} / ${posts.length}`);
    console.log(`   ⛔ Posts with ZERO impressions: ${zeroImpr.length} / ${posts.length}`);

    // 5) URL Inspection on samples of both cohorts
    const zeroVerdicts = await inspectCohort(client, site.gsc_property_uri, base, zeroImpr, ZERO_IMPR_SAMPLE, 'ZERO-impression');
    const withVerdicts = await inspectCohort(client, site.gsc_property_uri, base, withImpr, WITH_IMPR_SAMPLE, 'with-impression (control)');

    console.log(`\n  🔎 ZERO-impression cohort coverage (sample of ${Math.min(ZERO_IMPR_SAMPLE, zeroImpr.length)}):`);
    for (const [k, v] of Object.entries(zeroVerdicts).sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(3)} × ${k}`);
    console.log(`  🔎 With-impression cohort coverage (control sample of ${Math.min(WITH_IMPR_SAMPLE, withImpr.length)}):`);
    for (const [k, v] of Object.entries(withVerdicts).sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(3)} × ${k}`);
  }

  await mysqlPool.end();
  console.log('\n✅ Diagnostic complete.');
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
