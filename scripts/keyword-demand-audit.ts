/**
 * KEYWORD DEMAND AUDIT — pull REAL Google Ads metrics (DataForSEO) for the
 * primary keyword of every published post and answer the question fabricated
 * metrics never could: does anything we published target actual search demand?
 *
 *   npx tsx scripts/keyword-demand-audit.ts
 *
 * Outputs:
 *   review/keyword-demand-audit.md   — summary + the four action buckets
 *   review/keyword-demand-audit.csv  — one row per post (spreadsheet-friendly)
 * Also writes real volume/cpc/difficulty back onto matching `keywords` rows so
 * future topic planning stops trusting LLM-estimated numbers.
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs';
import path from 'node:path';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { KeywordService } from '../src/services/keywordService.js';
import { buildPostUrl } from '../src/services/sitemapService.js';

interface PostRow extends RowDataPacket {
  id: string;
  slug: string;
  title: string;
  primary_keyword: string;
  index_state: string | null;
  domain: string;
  impressions: number;
}

function bucketVolume(v: number | null): 'phantom' | 'tiny' | 'modest' | 'real' {
  if (!v || v <= 0) return 'phantom';
  if (v < 50) return 'tiny';
  if (v < 500) return 'modest';
  return 'real';
}

async function main() {
  const svc = new KeywordService({ pool: mysqlPool, gemini: null as any });
  if (!svc.dataForSeoEnabled()) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set in .env');

  const [posts] = await mysqlPool.query<PostRow[]>(
    `SELECT p.id, p.slug, p.title, p.primary_keyword, p.index_state, w.domain,
            COALESCE((SELECT SUM(m.total_impr) FROM gsc_page_metrics m WHERE m.post_id = p.id), 0) AS impressions
       FROM posts p JOIN websites w ON w.id = p.website_id
      WHERE p.status = 'published' AND p.primary_keyword IS NOT NULL AND p.primary_keyword != ''`
  );
  const keywords = [...new Set((posts as PostRow[]).map((p) => p.primary_keyword.toLowerCase().trim()))];
  console.log(`Published posts: ${posts.length} | distinct primary keywords: ${keywords.length}`);

  const metrics = await svc.dataForSeoSearchVolume(keywords);
  console.log(`Metrics returned for ${metrics.size} keywords`);

  // Write real metrics back onto matching keywords-table rows (kills the fabricated numbers).
  let updated = 0;
  for (const [kw, m] of metrics) {
    const [res] = await mysqlPool.query<ResultSetHeader>(
      `UPDATE keywords SET volume = ?, cpc = ?, difficulty = ? WHERE LOWER(keyword) = ?`,
      [m.volume ?? 0, m.cpc ?? 0, m.difficulty ?? 0, kw]
    );
    updated += res.affectedRows ?? 0;
  }
  console.log(`keywords table rows updated with real metrics: ${updated}`);

  type Enriched = PostRow & { volume: number | null; cpc: number | null; difficulty: number | null; bucket: string };
  const enriched: Enriched[] = (posts as PostRow[]).map((p) => {
    const m = metrics.get(p.primary_keyword.toLowerCase().trim());
    return { ...p, volume: m?.volume ?? null, cpc: m?.cpc ?? null, difficulty: m?.difficulty ?? null, bucket: bucketVolume(m?.volume ?? null) };
  });

  const byBucket = (b: string) => enriched.filter((p) => p.bucket === b);
  const indexed = (arr: Enriched[]) => arr.filter((p) => p.index_state === 'indexed');

  // The four action buckets
  const phantomAll = byBucket('phantom');
  const demandAll = enriched.filter((p) => p.bucket !== 'phantom');
  const indexedPhantom = indexed(phantomAll);
  const indexedDemandNoImpr = indexed(demandAll).filter((p) => Number(p.impressions) === 0);
  const notIndexedDemand = demandAll.filter((p) => p.index_state !== 'indexed');
  const winnable = demandAll.filter((p) => (p.difficulty ?? 100) <= 40 && (p.volume ?? 0) >= 50);

  const outDir = path.resolve('review');
  fs.mkdirSync(outDir, { recursive: true });

  // CSV
  const csv = ['url,keyword,volume,cpc,difficulty,bucket,index_state,impressions'];
  for (const p of enriched.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))) {
    csv.push([
      buildPostUrl(p.domain, p.slug),
      `"${p.primary_keyword.replace(/"/g, '""')}"`,
      p.volume ?? '', p.cpc ?? '', p.difficulty ?? '', p.bucket, p.index_state ?? 'unscanned', p.impressions,
    ].join(','));
  }
  fs.writeFileSync(path.join(outDir, 'keyword-demand-audit.csv'), csv.join('\n'));

  // Markdown summary
  const pct = (n: number) => `${Math.round((n / enriched.length) * 100)}%`;
  const md: string[] = [];
  md.push(`# Keyword Demand Audit — ${new Date().toISOString().slice(0, 10)}\n`);
  md.push(`Real Google Ads metrics (DataForSEO) for the primary keyword of every published post.\n`);
  md.push(`## Demand distribution (${enriched.length} posts)\n`);
  md.push(`| Bucket | Posts | Share |\n|---|---|---|`);
  md.push(`| PHANTOM (0 / unknown volume) | ${phantomAll.length} | ${pct(phantomAll.length)} |`);
  md.push(`| TINY (1-49/mo) | ${byBucket('tiny').length} | ${pct(byBucket('tiny').length)} |`);
  md.push(`| MODEST (50-499/mo) | ${byBucket('modest').length} | ${pct(byBucket('modest').length)} |`);
  md.push(`| REAL (500+/mo) | ${byBucket('real').length} | ${pct(byBucket('real').length)} |\n`);
  md.push(`## Action buckets\n`);
  md.push(`- **Indexed but phantom demand** (${indexedPhantom.length}): indexed pages nobody searches for → remap keyword or retire; rewriting alone cannot help.`);
  md.push(`- **Indexed + demand, zero impressions** (${indexedDemandNoImpr.length}): ranking too deep → tier-2 refresh + internal links + authority.`);
  md.push(`- **Not indexed + demand** (${notIndexedDemand.length}): worth the rescue/index push — real demand waits behind indexing.`);
  md.push(`- **Winnable now (volume ≥ 50, difficulty ≤ 40)** (${winnable.length}): the priority rewrite list.\n`);
  md.push(`## Top 30 winnable keywords (volume ≥ 50, difficulty ≤ 40)\n`);
  md.push(`| Keyword | Vol/mo | Diff | CPC | Index state | Post |\n|---|---|---|---|---|---|`);
  for (const p of winnable.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, 30)) {
    md.push(`| ${p.primary_keyword} | ${p.volume} | ${p.difficulty} | $${p.cpc ?? '?'} | ${p.index_state ?? 'unscanned'} | /${p.slug} |`);
  }
  md.push(`\n## Top 20 phantom-demand posts (highest-effort content, zero search demand)\n`);
  md.push(`| Keyword | Index state | Post |\n|---|---|---|`);
  for (const p of phantomAll.slice(0, 20)) {
    md.push(`| ${p.primary_keyword} | ${p.index_state ?? 'unscanned'} | /${p.slug} |`);
  }
  fs.writeFileSync(path.join(outDir, 'keyword-demand-audit.md'), md.join('\n'));

  console.log(`\n══ SUMMARY ══`);
  console.log(`PHANTOM: ${phantomAll.length} (${pct(phantomAll.length)}) | TINY: ${byBucket('tiny').length} | MODEST: ${byBucket('modest').length} | REAL: ${byBucket('real').length}`);
  console.log(`Indexed+phantom: ${indexedPhantom.length} | Indexed+demand+0impr: ${indexedDemandNoImpr.length} | NotIndexed+demand: ${notIndexedDemand.length} | Winnable: ${winnable.length}`);
  console.log(`\nWritten: review/keyword-demand-audit.md + .csv`);
  await mysqlPool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
