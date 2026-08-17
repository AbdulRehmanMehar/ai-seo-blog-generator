/**
 * REQUEST RECRAWL — nudges Google to re-crawl each site after a content push, via
 * the service-account Search Console integration (googleAuth.ts + gscClient.ts):
 * re-submits every site's live sitemap so Google re-fetches it and queues new or
 * changed URLs for crawling. Prints before/after sitemap status plus current
 * coverage numbers so the effect is visible.
 *
 *   npx tsx scripts/request-recrawl.ts
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { buildGscClient } from '../src/services/gscClient.js';

async function main() {
  const client = buildGscClient();
  if (!client) throw new Error('GSC is not configured (no service account or OAuth credentials).');

  const [sites] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT domain, gsc_property_uri FROM websites WHERE gsc_property_uri IS NOT NULL`
  );

  for (const site of sites as Array<{ domain: string; gsc_property_uri: string }>) {
    const feedpath = `https://${site.domain}/sitemap.xml`;
    console.log(`\n=== ${site.domain} (${site.gsc_property_uri}) ===`);

    try {
      await client.submitSitemap(site.gsc_property_uri, feedpath);
      console.log(`✓ Sitemap re-submitted: ${feedpath} — Google will re-fetch it and queue new/changed URLs for crawling.`);
    } catch (err) {
      console.log(`⚠️ Sitemap submit failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    try {
      const coverage = await client.getSitemapCoverage(site.gsc_property_uri);
      if (coverage.length === 0) {
        console.log('  (no coverage data yet — first submission can take a while to show up)');
      }
      for (const c of coverage) {
        console.log(`  ${c.path} [${c.type}]: ${c.submitted} submitted, ${c.indexed} indexed`);
      }
    } catch (err) {
      console.log(`  (coverage check failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
