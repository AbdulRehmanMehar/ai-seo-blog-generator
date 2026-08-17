/**
 * PRUNE THIN POSTS — redirect posts that failed the brand realign's depth
 * gate (genuinely too thin to expand without fabrication, mostly the old
 * off-brand enterprise corpus) into the most topically-related SURVIVING
 * post on the SAME website. Reuses ConsolidationService.markMerged so the
 * redirect, chain-flattening, and Next.js 301 contract are identical to the
 * proven June/July consolidation runs.
 *
 * HARD RULE: redirects NEVER cross website_id. A candidate survivor must be
 * on the exact same site as the post being redirected — enforced by querying
 * candidates WHERE website_id = <source's website_id> only.
 *
 * A similarity floor prevents forcing a bad match: posts with no same-site
 * neighbor above the floor are left untouched and reported separately rather
 * than redirected somewhere irrelevant.
 *
 *   npx tsx scripts/prune-thin-posts.ts <ids-file> --dry     # plan only
 *   npx tsx scripts/prune-thin-posts.ts <ids-file> --apply
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs';
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { ConsolidationService } from '../src/services/consolidationService.js';

const SIMILARITY_FLOOR = 0.72;

function parseVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') { try { return JSON.parse(v) as number[]; } catch { return null; } }
  return null;
}

async function main() {
  const idsFile = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!idsFile) throw new Error('usage: prune-thin-posts.ts <ids-file> [--apply]');
  const thinIds = fs.readFileSync(idsFile, 'utf8').trim().split('\n').filter(Boolean);

  // Confirm these are still actually published (not already fixed by a later retry).
  const placeholders = thinIds.map(() => '?').join(',');
  const [thinRows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, slug, title, website_id, index_state, updated_at FROM posts
      WHERE id IN (${placeholders}) AND status = 'published'`,
    thinIds
  );
  console.log(`Requested: ${thinIds.length} | still published (not yet fixed by a retry): ${(thinRows as any[]).length}`);

  const [allRows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, slug, website_id, index_state FROM posts WHERE status = 'published'`
  );
  const metaById = new Map<string, any>((allRows as any[]).map((r) => [String(r.id), r]));
  const thinIdSet = new Set((thinRows as any[]).map((r) => String(r.id)));

  const pg = await postgresPool.query(`SELECT entity_id, embedding FROM embeddings WHERE entity_type = 'post'`);
  const vecById = new Map<string, number[]>();
  for (const row of pg.rows as any[]) {
    const v = parseVec(row.embedding);
    if (v && metaById.has(String(row.entity_id))) vecById.set(String(row.entity_id), v);
  }
  const norm = (v: number[]) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); };
  const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

  // Survivor candidates per website: every published post NOT in the thin set (never
  // redirect to a page that's itself about to be redirected), with an embedding.
  const candidatesByWebsite = new Map<string, Array<{ id: string; slug: string; vec: number[] }>>();
  for (const [id, meta] of metaById) {
    if (thinIdSet.has(id)) continue;
    const vec = vecById.get(id);
    if (!vec) continue;
    const list = candidatesByWebsite.get(String(meta.website_id)) ?? [];
    list.push({ id, slug: String(meta.slug), vec: norm(vec) });
    candidatesByWebsite.set(String(meta.website_id), list);
  }

  const matches: Array<{ source: any; survivorSlug: string; score: number }> = [];
  const noMatch: any[] = [];
  for (const r of thinRows as any[]) {
    const vec = vecById.get(String(r.id));
    const candidates = candidatesByWebsite.get(String(r.website_id)) ?? [];
    if (!vec || candidates.length === 0) { noMatch.push(r); continue; }
    const sourceVec = norm(vec);
    let best: { slug: string; score: number } | null = null;
    for (const c of candidates) {
      const score = dot(sourceVec, c.vec);
      if (!best || score > best.score) best = { slug: c.slug, score };
    }
    if (best && best.score >= SIMILARITY_FLOOR) {
      matches.push({ source: r, survivorSlug: best.slug, score: best.score });
    } else {
      noMatch.push(r);
    }
  }

  console.log(`\nMatched (≥ ${SIMILARITY_FLOOR} same-site similarity): ${matches.length}`);
  console.log(`No suitable same-site match (left alone, reported): ${noMatch.length}`);

  const scoreBuckets = { '0.90+': 0, '0.85-0.90': 0, '0.80-0.85': 0, '0.72-0.80': 0 };
  for (const m of matches) {
    if (m.score >= 0.90) scoreBuckets['0.90+']++;
    else if (m.score >= 0.85) scoreBuckets['0.85-0.90']++;
    else if (m.score >= 0.80) scoreBuckets['0.80-0.85']++;
    else scoreBuckets['0.72-0.80']++;
  }
  console.log('Score distribution:', JSON.stringify(scoreBuckets));

  console.log('\nSample matches:');
  for (const m of matches.slice(0, 10)) {
    console.log(`  ${m.score.toFixed(3)}  /${m.source.slug} → /${m.survivorSlug}`);
  }
  if (noMatch.length > 0) {
    console.log('\nNo-match posts (left published, untouched):');
    for (const r of noMatch.slice(0, 15)) console.log(`  /${r.slug} — "${String(r.title).slice(0, 60)}"`);
  }

  if (!apply) {
    console.log('\nDRY RUN — pass --apply to execute.');
    await mysqlPool.end(); await postgresPool.end();
    process.exit(0);
  }

  const consolidation = new ConsolidationService({ mysql: mysqlPool, postgres: postgresPool });
  let merged = 0, failed = 0;
  for (const m of matches) {
    try {
      const ok = await consolidation.markMerged(m.source.id, m.source.slug, m.survivorSlug);
      if (ok) merged++; else failed++;
    } catch (e) {
      failed++;
      console.log(`✗ ${m.source.slug}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
    }
  }
  const chainsFixed = await consolidation.flattenRedirects();
  console.log(`\n══ APPLIED ══`);
  console.log(`merged: ${merged} | failed: ${failed} | chains flattened: ${chainsFixed}`);
  await mysqlPool.end();
  await postgresPool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
