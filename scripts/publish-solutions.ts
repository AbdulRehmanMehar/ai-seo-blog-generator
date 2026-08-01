/**
 * PUBLISH SOLUTIONS — flips every approved (reviewed_by set), still-draft solutions page
 * for a website to status='published', then regenerates the sitemap so published pages
 * are included.
 *
 *   npx tsx scripts/publish-solutions.ts
 *   npx tsx scripts/publish-solutions.ts primestrides.com
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { mysqlPool } from '../src/db/mysqlPool.js';
import { WebsiteService } from '../src/services/websiteService.js';
import { SolutionsService } from '../src/services/solutionsService.js';
import { SitemapService } from '../src/services/sitemapService.js';
import type { GeminiClient } from '../src/llm/geminiClient.js';

const TARGET_DOMAIN = process.argv[2] ?? 'theabdulrehman.com';

async function main() {
  const websiteService = new WebsiteService(mysqlPool);
  const website = await websiteService.getByDomain(TARGET_DOMAIN);
  if (!website) throw new Error(`Website not found for domain ${TARGET_DOMAIN}`);

  // Publishing is a status flip + a sitemap regeneration — no generation or embedding
  // happens here, so no real GeminiClient is needed.
  const solutions = new SolutionsService({ pool: mysqlPool, gemini: null as unknown as GeminiClient });
  const count = await solutions.publishApprovedSolutions(website.id);
  console.log(`Published ${count} approved solutions page(s) for ${TARGET_DOMAIN}.`);

  if (count > 0) {
    const results = await new SitemapService(mysqlPool).generateAll();
    for (const r of results) {
      console.log(`Sitemap updated: ${r.filePath} (${r.urlCount} URLs) for ${r.domain}`);
    }
  }

  await mysqlPool.end();
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
