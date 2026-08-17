/**
 * PING REDIRECTED URLS — nudge Google to re-crawl the OLD url of consolidated posts
 * so it discovers the 301 and moves them out of "Crawled - currently not indexed"
 * into "Page with redirect".
 *
 * WHY THIS EXISTS
 * The existing tooling does not reach these URLs:
 *   - request-recrawl.ts resubmits sitemaps, and redirected URLs are (correctly) not
 *     in the sitemap, so a sitemap ping never reaches them.
 *   - google-indexing-ping.ts selects PUBLISHED posts changed in the last N days;
 *     merged posts are excluded by that filter.
 * After a consolidation batch, the redirected URLs are usually the largest block of
 * "crawled - not indexed" in Search Console, and nothing was prompting a re-crawl.
 *
 * SAFETY: A URL IS ONLY PINGED ONCE ITS REDIRECT IS ACTUALLY LIVE.
 * Every candidate is fetched first and must answer 301/302/307/308. This is not a nicety.
 * GoogleIndexingService records every ping in `google_indexing_pings` and will only
 * re-ping a URL whose lastmod is strictly LATER than the last ping date. Pinging before
 * the frontend has deployed would therefore (a) waste quota telling Google to re-crawl a
 * page that still returns 200, and (b) poison the ledger, so the URL could never be
 * re-pinged after the deploy without touching the row again. Checking first makes the
 * script safe to run at any time — before deploy it simply reports that nothing is live.
 *
 *   npx tsx scripts/ping-redirected-urls.ts                # dry run, default cap
 *   npx tsx scripts/ping-redirected-urls.ts --apply        # send pings
 *   npx tsx scripts/ping-redirected-urls.ts --apply 50     # cap this run at 50
 *   npx tsx scripts/ping-redirected-urls.ts --apply --all  # ignore index_state priority
 *
 * Quota: the Indexing API project quota is nominally 200/day and in practice lower, so
 * the default cap is conservative and the batch aborts on the first quota/permission
 * error rather than burning the rest of the day's allowance on guaranteed failures.
 * Re-run on subsequent days to work through a large backlog.
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import { mysqlPool } from '../src/db/mysqlPool.js';
import type { PublishedPostUrl } from '../src/services/sitemapService.js';
import { GoogleIndexingService } from '../src/services/googleIndexingService.js';
import { IndexNowService } from '../src/services/indexNowService.js';
import { RedirectRecrawlService } from '../src/services/redirectRecrawlService.js';

const DEFAULT_CAP = 60;

async function main() {
  const apply = process.argv.includes('--apply');
  const capArg = process.argv.find((a) => /^\d+$/.test(a));
  const cap = capArg ? Number(capArg) : DEFAULT_CAP;

  // Same selection + live-redirect gate the pipeline uses (RedirectRecrawlService),
  // so a manual drain and the scheduled step can never diverge.
  const recrawl = new RedirectRecrawlService(mysqlPool);
  const candidates = await recrawl.findCandidates(cap * 6);
  console.log(`candidates in a not-indexed state: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log('nothing to do.');
    await mysqlPool.end();
    return;
  }

  console.log('checking which redirects are live...');
  const batch: PublishedPostUrl[] = await recrawl.takeLive(candidates, cap);
  if (batch.length === 0) {
    console.log('\nNo candidate is serving a redirect yet — the site has not picked up the');
    console.log('database changes. Nothing was pinged: doing so would waste quota and write');
    console.log('ledger rows that block a later, useful ping.');
    await mysqlPool.end();
    return;
  }

  console.log(`\n${apply ? 'PINGING' : 'DRY RUN'} ${batch.length} live redirects (cap ${cap})`);
  for (const b of batch.slice(0, 15)) console.log(`   ${b.url}`);
  if (batch.length > 15) console.log(`   ... and ${batch.length - 15} more`);

  if (!apply) {
    console.log('\nDRY RUN — pass --apply to send.');
    if (batch.length === cap) console.log(`NOTE: hit the ${cap}-URL cap; more may remain beyond it.`);
    await mysqlPool.end();
    return;
  }

  // ---- Google Indexing API (quota-limited) ----
  // Must use the static factory: the constructor is private and builds the JWT auth.
  // `new GoogleIndexingService()` compiles under tsx (scripts/ is outside tsconfig's
  // include) but yields an instance with no auth, so every publish call fails.
  const indexing = GoogleIndexingService.build();
  if (!indexing) {
    console.log('\nGoogle Indexing API: no service account configured — skipped.');
  } else {
    const res = await indexing.pingUpdatedUrls(mysqlPool, batch, cap);
    console.log(`\nGoogle Indexing API: pinged=${res.pinged} skipped(already current)=${res.skipped} failed=${res.failed}`);
    if (res.abortReason) console.log(`  ABORTED EARLY: ${res.abortReason}`);
  }

  // ---- IndexNow (free, no quota — Bing/Yandex, harmless secondary signal) ----
  try {
    const indexNow = new IndexNowService();
    const submissions = await indexNow.submitUrls(batch);
    for (const s of submissions) console.log(`IndexNow ${s.domain}: submitted=${s.submitted} ok=${s.ok}${s.status ? ` status=${s.status}` : ''}${s.error ? ` error=${s.error}` : ''}`);
    if (submissions.length === 0) console.log('IndexNow: not configured (no key) — skipped.');
  } catch (e) {
    console.log(`IndexNow failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }

  if (batch.length === cap) {
    console.log(`\nHit the ${cap}-URL cap — more may remain. Re-run tomorrow, or let the`);
    console.log('pipeline drain the rest automatically (REDIRECT_RECRAWL_PINGS_PER_RUN).');
  }
  await mysqlPool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
