/**
 * INDEX STATUS + DUPLICATE CLUSTER REPORT (read-mostly)
 *
 * 1. Scans every published post against the Google URL Inspection API and stores its
 *    index_state on the post (rotating; safe to re-run).
 * 2. Prints the index-state breakdown per site.
 * 3. Clusters near-duplicate posts to size the consolidation opportunity. Uses the
 *    pgvector embeddings (semantic) when available, else a MySQL title/keyword heuristic.
 *
 * Run: npx tsx scripts/index-status-report.ts
 */
import 'dotenv/config';
import dns from 'node:dns';
// This box has broken IPv6 egress; Google resolves IPv6-first and google-auth's
// node-fetch hangs on it. Force IPv4 for every lookup.
dns.setDefaultResultOrder('ipv4first');
const _origLookup = dns.lookup;
(dns as any).lookup = function (hostname: string, options: any, callback: any) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  opts.family = 4;
  return (_origLookup as any)(hostname, opts, callback);
};
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { GscIndexStatusService } from '../src/services/gscIndexStatusService.js';

async function runIndexScan() {
  console.log('═'.repeat(70));
  console.log('STEP 1: Scanning Google index status for every published post');
  console.log('  (URL Inspection API, ~0.7s each — this takes several minutes)');
  console.log('═'.repeat(70));

  const svc = new GscIndexStatusService(mysqlPool);
  const result = await svc.scanBatch({ limit: 2000, delayMs: 700 });
  console.log(`\nScanned ${result.scanned} posts. States this run:`);
  for (const [k, v] of Object.entries(result.byState).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(v).padStart(4)}  ${k}`);
  }

  console.log('\nIndex-state breakdown per site (stored):');
  const summary = await svc.getSummary();
  let curDomain = '';
  for (const row of summary) {
    if (row.domain !== curDomain) { console.log(`\n  ${row.domain}:`); curDomain = row.domain; }
    console.log(`     ${String(row.count).padStart(4)}  ${row.state}`);
  }
}

function unionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const groups = () => {
    const m = new Map<number, number[]>();
    for (let i = 0; i < n; i++) { const r = find(i); (m.get(r) ?? m.set(r, []).get(r)!).push(i); }
    return [...m.values()];
  };
  return { find, union, groups };
}

function printClusters(
  label: string,
  threshold: number,
  pairLine: string,
  ids: string[],
  meta: Map<string, { title: string; state: string }>,
  groups: number[][]
) {
  const multi = groups.filter((c) => c.length >= 2).sort((a, b) => b.length - a.length);
  const inClusters = multi.reduce((s, c) => s + c.length, 0);
  const n = ids.length;
  console.log(`\n${label}`);
  console.log(pairLine);
  console.log(`At threshold ${threshold}:`);
  console.log(`   Near-duplicate clusters (size ≥ 2): ${multi.length}`);
  console.log(`   Posts inside clusters: ${inClusters} / ${n}  (${Math.round((inClusters / n) * 100)}%)`);
  console.log(`   Standalone posts: ${n - inClusters}`);
  console.log(`   → Consolidating would collapse ~${inClusters} posts into ~${multi.length} survivors.`);
  console.log(`\nLargest near-duplicate clusters:`);
  for (const c of multi.slice(0, 12)) {
    const indexed = c.filter((i) => meta.get(ids[i]!)?.state === 'indexed').length;
    console.log(`\n   • ${c.length} posts (${indexed} indexed):`);
    for (const i of c.slice(0, 4)) console.log(`       [${meta.get(ids[i]!)?.state}] ${meta.get(ids[i]!)?.title.slice(0, 76)}`);
    if (c.length > 4) console.log(`       … +${c.length - 4} more`);
  }
}

function parseVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') { try { return JSON.parse(v) as number[]; } catch { return null; } }
  return null;
}

/** Semantic clustering from pgvector embeddings. Throws if embeddings are unavailable. */
async function clusterByEmbeddings(meta: Map<string, { title: string; state: string }>) {
  const pg = await postgresPool.query(`SELECT entity_id, embedding FROM embeddings WHERE entity_type = 'post'`);
  const ids: string[] = [];
  const vecs: number[][] = [];
  for (const row of pg.rows as any[]) {
    const v = parseVec(row.embedding);
    if (v && meta.has(String(row.entity_id))) { ids.push(String(row.entity_id)); vecs.push(v); }
  }
  if (ids.length === 0) throw new Error('no post embeddings present');

  const norm = vecs.map((v) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); });
  const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
  const n = ids.length;
  const uf = unionFind(n);
  let p85 = 0, p90 = 0, p95 = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const c = dot(norm[i]!, norm[j]!);
    if (c >= 0.85) p85++;
    if (c >= 0.90) p90++;
    if (c >= 0.95) p95++;
    if (c >= 0.90) uf.union(i, j);
  }
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 2: Near-duplicate clusters (SEMANTIC — pgvector embeddings)');
  console.log('═'.repeat(70));
  printClusters(`Posts with embeddings: ${n}`, 0.90, `Cosine pairs:  ≥0.85: ${p85}   ≥0.90: ${p90}   ≥0.95: ${p95}`, ids, meta, uf.groups());
}

const STOPWORDS = new Set(['the','a','an','and','or','for','to','of','in','on','your','you','with','how','why','what','is','are','that','this','from','it','as','at','by','be','not','no','can','will','should','do','does','when','who','where','into','about']);
function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  const u = a.size + b.size - inter; return u === 0 ? 0 : inter / u;
}

/** Fallback: lexical clustering from MySQL titles + keywords (no embeddings needed). */
async function clusterByHeuristic(meta: Map<string, { title: string; state: string }>) {
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, title, primary_keyword FROM posts WHERE status = 'published'`
  );
  const ids: string[] = [];
  const toks: Set<string>[] = [];
  for (const r of rows as any[]) {
    if (!meta.has(String(r.id))) continue;
    ids.push(String(r.id));
    toks.push(tokens(`${r.title} ${r.primary_keyword ?? ''}`));
  }
  const n = ids.length;
  const uf = unionFind(n);
  let p40 = 0, p50 = 0, p60 = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const s = jaccard(toks[i]!, toks[j]!);
    if (s >= 0.4) p40++;
    if (s >= 0.5) p50++;
    if (s >= 0.6) p60++;
    if (s >= 0.5) uf.union(i, j);
  }
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 2: Near-duplicate clusters (title/keyword heuristic — embeddings unavailable)');
  console.log('═'.repeat(70));
  printClusters(`Published posts analyzed: ${n}`, 0.5, `Jaccard pairs:  ≥0.4: ${p40}   ≥0.5: ${p50}   ≥0.6: ${p60}`, ids, meta, uf.groups());
}

async function runClusterAnalysis() {
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, title, COALESCE(index_state,'unscanned') AS state FROM posts WHERE status = 'published'`
  );
  const meta = new Map<string, { title: string; state: string }>();
  for (const r of rows as any[]) meta.set(String(r.id), { title: String(r.title), state: String(r.state) });

  try {
    await clusterByEmbeddings(meta);
  } catch (e) {
    console.log(`\n(embedding clustering unavailable: ${e instanceof Error ? e.message : String(e)} — falling back to heuristic)`);
    await clusterByHeuristic(meta);
  }
}

async function main() {
  // SKIP_SCAN=1 → skip the slow GSC URL-Inspection pass and just print the stored
  // index-state summary + the (fast) duplicate-cluster analysis.
  if (process.env.SKIP_SCAN) {
    console.log('(SKIP_SCAN set — using already-stored index states)');
    const svc = new GscIndexStatusService(mysqlPool);
    console.log('\nIndex-state breakdown per site (stored so far):');
    let curDomain = '';
    for (const row of await svc.getSummary()) {
      if (row.domain !== curDomain) { console.log(`\n  ${row.domain}:`); curDomain = row.domain; }
      console.log(`     ${String(row.count).padStart(4)}  ${row.state}`);
    }
  } else {
    await runIndexScan();
  }
  try { await runClusterAnalysis(); } catch (e) {
    console.log(`\n⚠️ Cluster analysis failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await mysqlPool.end();
  try { await postgresPool.end(); } catch { /* ignore */ }
  console.log('\n✅ Report complete.');
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
