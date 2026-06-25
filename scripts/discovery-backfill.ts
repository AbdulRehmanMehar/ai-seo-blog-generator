/**
 * DISCOVERY BACKFILL — fixes the "URL unknown to Google" (orphaned) posts.
 *
 * No LLM. Three steps:
 *   1. Build the internal-link graph from embeddings (each post links to its nearest
 *      siblings on the same site) so orphaned posts are reachable.
 *   2. Regenerate per-site sitemaps (merged posts excluded automatically).
 *   3. Submit published URLs to IndexNow (Bing/Yandex) if INDEXNOW_KEY is set.
 *
 * Run: npx tsx scripts/discovery-backfill.ts
 *
 * IMPORTANT (frontend): for this to help Google, the Next.js app must (a) render
 * content_json.internalLinks as real <a href> links, and (b) serve + submit the
 * generated sitemap at https://{domain}/sitemap.xml in Search Console.
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { RelatedLinkService } from '../src/services/relatedLinkService.js';
import { SitemapService } from '../src/services/sitemapService.js';
import { IndexNowService } from '../src/services/indexNowService.js';

async function main() {
  console.log('STEP 1: Injecting embedding-based internal links (no LLM)…');
  const linker = new RelatedLinkService({ mysql: mysqlPool, postgres: postgresPool });
  const linkRes = await linker.injectEmbeddingLinks({ perPost: 6, minSimilarity: 0.4 });
  console.log(`   ✓ Linked ${linkRes.updated} / ${linkRes.processed} published posts (≤6 related links each)`);

  console.log('\nSTEP 2: Regenerating sitemaps…');
  const sitemap = new SitemapService(mysqlPool);
  const maps = await sitemap.generateAll();
  for (const m of maps) console.log(`   ✓ ${m.filePath} (${m.urlCount} URLs for ${m.domain})`);
  if (maps.length === 0) console.log('   (no published posts?)');

  console.log('\nSTEP 3: IndexNow submission…');
  const indexNow = new IndexNowService();
  if (!indexNow.isEnabled()) {
    console.log('   (skipped — INDEXNOW_KEY not set)');
  } else {
    await indexNow.writeKeyFile();
    const urls = await sitemap.getPublishedUrls();
    const subs = await indexNow.submitUrls(urls);
    for (const s of subs) console.log(`   ${s.ok ? '✓' : '✗'} ${s.domain}: ${s.submitted} URLs (${s.ok ? 'HTTP ' + s.status : s.error})`);
  }

  console.log('\n✅ Discovery backfill complete.');
  console.log('⚠️  Frontend must render content_json.internalLinks as <a> links AND serve+submit');
  console.log('    the sitemap at https://{domain}/sitemap.xml in Search Console for Google to benefit.');

  await mysqlPool.end();
  await postgresPool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
