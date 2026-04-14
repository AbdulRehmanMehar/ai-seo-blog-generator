import { mysqlPool } from '../db/mysqlPool.js';
import { WebsiteService } from '../services/websiteService.js';
import { ContentBriefService } from '../services/contentBriefService.js';
import { resolveGa4PropertyIdForDomain } from '../services/ga4Client.js';

async function main() {
  const websiteService = new WebsiteService(mysqlPool);
  const briefService = new ContentBriefService();

  const websites = await websiteService.getActiveWebsites();
  if (websites.length === 0) throw new Error('No active websites found');

  // Print briefs for all active websites so you can verify both properties.
  for (const site of websites) {
    const siteUrl = site.gscPropertyUri ?? `sc-domain:${site.domain}`;
    const ga4PropertyId = site.ga4PropertyId?.trim()
      ? site.ga4PropertyId.trim()
      : resolveGa4PropertyIdForDomain(site.domain);

    const brief = await briefService.generateContentBrief({
      siteUrl,
      ga4PropertyId,
      daysBack: 90,
    });

    // eslint-disable-next-line no-console
    console.log(brief);
    // eslint-disable-next-line no-console
    console.log('\n\n');
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

