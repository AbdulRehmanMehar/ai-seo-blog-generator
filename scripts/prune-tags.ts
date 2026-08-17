/**
 * PRUNE JUNK TAGS — removes clickbait/title-fragment tags that the no-LLM phrase
 * extractor picked up (a symptom of formulaic titles), keeping only real topic tags.
 * Deletes the tags + their post_tags, recomputes indexability, refreshes sitemaps.
 *
 * Run: npx tsx scripts/prune-tags.ts
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { TaxonomyService } from '../src/services/taxonomyService.js';
import { SitemapService } from '../src/services/sitemapService.js';

// Curated junk list (exact tag names, case-insensitive). These are title-template
// fragments / clickbait phrases, not real topics.
const JUNK = new Set([
  'hidden reason', 'bleeding millions', 'unless you fix', 'annually unless', 'millions unless',
  'risk unless', 'fix these', 'fails during', 'projects keep', 'architects make',
  'during peak', 'during peak season', '200k mistake', '500k mistake', '500 million',
  'million mistake', 'million dollar', 'hidden cost', 'hidden costs', 'hidden security',
  'first development', 'valuation technical', 'strategic tech', '1990s support', '1990s support tech',
].map((s) => s.toLowerCase()));

async function main() {
  const [rows] = await mysqlPool.query<RowDataPacket[]>(`SELECT id, name FROM tags`);
  const toDelete = (rows as any[]).filter((r) => JUNK.has(String(r.name).toLowerCase()));
  const ids = toDelete.map((r) => String(r.id));

  console.log(`Tags total: ${(rows as any[]).length} | matching junk list: ${toDelete.length}`);
  if (ids.length === 0) { console.log('Nothing to prune.'); await mysqlPool.end(); return; }

  const placeholders = ids.map(() => '?').join(',');
  const [ptRes] = await mysqlPool.query<ResultSetHeader>(
    `DELETE FROM post_tags WHERE tag_id IN (${placeholders})`, ids
  );
  const [tRes] = await mysqlPool.query<ResultSetHeader>(
    `DELETE FROM tags WHERE id IN (${placeholders})`, ids
  );
  console.log(`✓ Removed ${tRes.affectedRows} tags and ${ptRes.affectedRows} post-tag assignments`);

  const taxonomy = new TaxonomyService({ pool: mysqlPool, gemini: null as any });
  const { indexableTags } = await taxonomy.recomputeCountsAndIndexability();
  const [[cnt]] = await mysqlPool.query<RowDataPacket[]>(`SELECT COUNT(*) c FROM tags`);
  console.log(`✓ Tags remaining: ${(cnt as any).c} | indexable: ${indexableTags}`);

  const maps = await new SitemapService(mysqlPool).generateAll();
  for (const m of maps) console.log(`✓ ${m.filePath} (${m.urlCount} URLs)`);

  await mysqlPool.end();
  console.log('\n✅ Prune complete.');
}

main().catch(async (e) => { console.error(e); try { await mysqlPool.end(); } catch {} process.exit(1); });
