/**
 * PUBLISH SERVICE PAGE — flips one approved (reviewed_by set) service-level page to
 * page_status='published', then regenerates the sitemap so the page + /solutions hub
 * are included.
 *
 *   npx tsx scripts/publish-service-page.ts booking-scheduling-intake
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { SolutionsService } from '../src/services/solutionsService.js';
import { SitemapService } from '../src/services/sitemapService.js';
import { GoogleIndexingService } from '../src/services/googleIndexingService.js';
import type { GeminiClient } from '../src/llm/geminiClient.js';

async function main() {
  const [serviceSlug] = process.argv.slice(2);
  if (!serviceSlug) {
    console.error('Usage: npx tsx scripts/publish-service-page.ts <service-slug>');
    process.exit(1);
  }

  const [[row]]: any = await mysqlPool.query(`SELECT id FROM services WHERE slug = ?`, [serviceSlug]);
  if (!row) throw new Error(`No service found with slug ${serviceSlug}`);

  // Publishing is a status flip + a sitemap regeneration — no generation happens here.
  const solutions = new SolutionsService({ pool: mysqlPool, gemini: null as unknown as GeminiClient });
  const ok = await solutions.publishServicePage(row.id);
  console.log(ok ? `Published service page ${serviceSlug}.` : `Did not publish ${serviceSlug} — see log above.`);

  if (ok) {
    const sitemap = new SitemapService(mysqlPool);
    const results = await sitemap.generateAll();
    for (const r of results) {
      console.log(`Sitemap updated: ${r.filePath} (${r.urlCount} URLs) for ${r.domain}`);
    }

    // Announce the newly published service page + hub to Google (fails soft).
    const googleIndexing = env.GOOGLE_INDEXING_PING_ENABLED ? GoogleIndexingService.build() : null;
    if (googleIndexing) {
      const urls = await sitemap.getServicePageUrls();
      const result = await googleIndexing.pingUpdatedUrls(
        mysqlPool,
        urls.map((u) => ({ url: u.url, lastmod: u.lastmod })),
        env.GOOGLE_INDEXING_PINGS_PER_RUN
      );
      console.log(
        result.abortReason
          ? `Google Indexing API: aborted after ${result.pinged} ping(s) — ${result.abortReason}`
          : `Google Indexing API: ${result.pinged} pinged, ${result.skipped} already announced, ${result.failed} failed`
      );
    }
  }

  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
