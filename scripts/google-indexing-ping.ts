/**
 * GOOGLE INDEXING API PING — notifies Google (URL_UPDATED) for recently
 * published/updated pages so they get queued for recrawl. Uses the existing
 * service account; requires "Web Search Indexing API" enabled in the Cloud
 * project and the service account as an OWNER of each GSC property.
 *
 * URL selection: all published solutions pages (niche + service + hub), plus
 * blog posts updated in the last DAYS days — capped under the API's default
 * 200-requests/day project quota.
 *
 *   npx tsx scripts/google-indexing-ping.ts              # last 7 days, cap 190
 *   npx tsx scripts/google-indexing-ping.ts 3 100        # last 3 days, cap 100
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
// Force ALL lookups to IPv4, not just prefer it: on connections with broken
// IPv6 (observed 2026-08-01 on a hotspot), the googleapis HTTP stack times out
// (ETIMEDOUT ~1.4s) instead of falling back to IPv4 the way curl does —
// 'ipv4first' alone did not fix it, family:4 did.
const origLookup = dns.lookup.bind(dns);
(dns as any).lookup = (hostname: string, options: any, cb?: any) => {
  if (typeof options === 'function') return origLookup(hostname, { family: 4 }, options);
  return origLookup(hostname, { ...(typeof options === 'object' && options ? options : {}), family: 4 }, cb);
};
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { GoogleIndexingService } from '../src/services/googleIndexingService.js';
import { buildPostUrl, buildSolutionUrl, buildServicePageUrl, buildSolutionsHubUrl } from '../src/services/sitemapService.js';

const DAYS = Number(process.argv[2] ?? 7);
const CAP = Number(process.argv[3] ?? 190);

async function main() {
  const indexing = GoogleIndexingService.build();
  if (!indexing) throw new Error('No Google service account configured.');

  const urls: string[] = [];

  const [solutions] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT w.domain, s.slug AS service_slug, n.slug AS niche_slug
       FROM solutions sol
       JOIN services s ON s.id = sol.service_id
       JOIN niches n ON n.id = sol.niche_id
       JOIN websites w ON w.id = sol.website_id
      WHERE sol.status = 'published'`
  );
  for (const r of solutions as any[]) {
    urls.push(buildSolutionUrl(String(r.domain), String(r.service_slug), String(r.niche_slug)));
  }

  const [servicePages] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT w.domain, s.slug FROM services s JOIN websites w ON w.id = s.website_id
      WHERE s.page_status = 'published' AND s.content_json IS NOT NULL`
  );
  const hubDomains = new Set<string>();
  for (const r of servicePages as any[]) {
    urls.push(buildServicePageUrl(String(r.domain), String(r.slug)));
    hubDomains.add(String(r.domain));
  }
  for (const d of hubDomains) urls.push(buildSolutionsHubUrl(d));

  const [posts] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT p.slug, w.domain FROM posts p JOIN websites w ON w.id = p.website_id
      WHERE p.status = 'published' AND p.updated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY p.updated_at DESC`,
    [DAYS]
  );
  for (const r of posts as any[]) {
    urls.push(buildPostUrl(String(r.domain), String(r.slug)));
  }

  const today = new Date().toISOString().slice(0, 10);
  const candidates = [...new Set(urls)].map((url) => ({ url, lastmod: today }));
  console.log(`Candidates: ${candidates.length} URL(s) (${(solutions as any[]).length} niche pages, ${(servicePages as any[]).length} service pages, ${hubDomains.size} hub, ${(posts as any[]).length} blog posts updated in last ${DAYS}d; cap ${CAP})`);

  // Shares the google_indexing_pings ledger with the cron pipeline, so a manual
  // run and the scheduled runs can never double-spend quota on the same URLs.
  const result = await indexing.pingUpdatedUrls(mysqlPool, candidates, CAP);
  console.log(
    result.abortReason
      ? `\nAborted after ${result.pinged} ping(s): ${result.abortReason}`
      : `\nDone: ${result.pinged} pinged, ${result.skipped} already announced (skipped), ${result.failed} failed.`
  );
  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
