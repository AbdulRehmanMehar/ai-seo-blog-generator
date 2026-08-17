/**
 * PHANTOM-KEYWORD REMAP — INDEXED SUBSET ONLY.
 *
 * Same purpose as phantom-remap.ts (find a real, validated buyer keyword for a
 * post currently targeting phantom demand) but scoped to posts Google has
 * CONFIRMED indexed. These can NEVER be redirected — only a same-URL, same-title
 * in-place content pivot is considered, and only when the new keyword is close
 * enough to the post's existing content (embedding floor) that the pivot reads
 * as a natural extension rather than a topic swap. Posts with no safe candidate
 * are left untouched and reported, per instruction: rewrite if possible, if not
 * possible just say so.
 *
 * Every post's CURRENT primary_keyword is re-verified fresh via DataForSEO before
 * being treated as phantom — the `keywords` table cannot be trusted (contaminated /
 * incomplete; a prior retarget can be real but never get backfilled there).
 *
 *   npx tsx scripts/phantom-remap-indexed.ts <indexed-ids-file>
 *
 * Writes review/phantom-indexed-remap-plan.md/.json + phantom-indexed-approved-slugs.txt.
 * Does NOT touch the database — apply-indexed-retargets.ts does that.
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RowDataPacket } from 'mysql2/promise';
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { KeywordService } from '../src/services/keywordService.js';
import { getBrandKnowledge } from '../src/knowledge/brandKnowledge.js';
import { safeJsonParse } from '../src/utils/json.js';
import { mapConcurrent } from '../src/utils/concurrency.js';

const decisionItemSchema = z.object({
  slug: z.string(),
  action: z.enum(['retarget', 'no_good_candidate']).nullish(),
  keyword: z.string().nullish(),
  lead_value: z.enum(['high', 'medium', 'low']).nullish(),
  reason: z.string().nullish(),
  content_angle: z.string().nullish(),
});
const decisionSchema = z.object({ decisions: z.array(z.unknown()).min(1) });

async function main() {
  const idsFile = process.argv[2];
  if (!idsFile) throw new Error('usage: phantom-remap-indexed.ts <indexed-ids-file>');
  const ids = fs.readFileSync(idsFile, 'utf8').trim().split('\n').filter(Boolean);

  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  const gemini = new GeminiClient({
    rateLimiter: new GeminiRateLimiter(mysqlPool, apiKeys),
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_PROVIDER === 'openrouter' ? 0 : env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
  const svc = new KeywordService({ pool: mysqlPool, gemini });
  if (!svc.dataForSeoEnabled()) throw new Error('DataForSEO credentials missing');

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT p.id, p.slug, p.title, p.primary_keyword, p.website_id, w.domain, p.index_state
       FROM posts p JOIN websites w ON w.id = p.website_id
      WHERE p.id IN (${placeholders}) AND p.status = 'published' AND p.index_state = 'indexed'`,
    ids
  );
  console.log(`Indexed candidates requested: ${ids.length} | still published+indexed: ${(rows as any[]).length}`);

  // ── Fresh re-verify: exclude any post whose current keyword actually has real
  // volume now (a prior retarget that never got backfilled into `keywords`) ──
  const sanitizeSeed = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const currentKwList = [...new Set((rows as any[]).map((r) => sanitizeSeed(String(r.primary_keyword || ''))).filter((s) => s.length >= 3))];
  const currentVolMap = await svc.dataForSeoSearchVolume(currentKwList);
  const realVolByKw = new Map([...currentVolMap.entries()].map(([kw, m]) => [kw.toLowerCase(), m.volume ?? 0]));
  const posts = (rows as any[]).filter((r) => (realVolByKw.get(sanitizeSeed(String(r.primary_keyword || ''))) ?? 0) < 50);
  const alreadyReal = (rows as any[]).filter((r) => !posts.includes(r));
  console.log(`Genuinely phantom (fresh-verified): ${posts.length} | already real (skipped, no action needed): ${alreadyReal.length}`);
  for (const r of alreadyReal) console.log(`  already-real: /${r.slug} — "${r.primary_keyword}"`);

  if (posts.length === 0) {
    console.log('\nNothing left to remap — all indexed candidates already have real keywords.');
    await mysqlPool.end();
    process.exit(0);
  }

  // ── Candidate pool: brand-family seeds + these posts' own titles, PLUS the
  // already-verified backlog (cheap, no extra API cost) ──
  const b0 = getBrandKnowledge();
  const BRAND_SEED_FAMILIES = [
    ...b0.target_market.sweet_spot_problems,
    'custom booking system for small business', 'online booking system for clinics',
    'workflow automation for small business', 'client intake automation',
    'custom crm for real estate agents', 'connect crm to scheduling software',
    'hire software development partner', 'mvp development for startups',
    'custom software for growing business', 'ai assistant for small business',
    'software for property management company', 'field service management software',
    'recruiting agency automation software', 'website performance optimization',
    'fractional cto services', 'virtual cto for small business',
    'secure code review services', 'legacy system modernization', 'technical due diligence for startups',
  ];
  const [ownedRows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT DISTINCT LOWER(TRIM(primary_keyword)) AS kw FROM posts WHERE status='published' AND primary_keyword IS NOT NULL`
  );
  const claimed = new Set((ownedRows as any[]).map((r) => String(r.kw)));

  let backlogPool: Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }> = [];
  try {
    const backlog = JSON.parse(fs.readFileSync(path.resolve('review/verified-keyword-backlog.json'), 'utf8'));
    backlogPool = backlog.backlog ?? [];
  } catch { /* optional */ }

  const seedSet = [...new Set(
    [...posts.map((p) => p.primary_keyword || p.title), ...BRAND_SEED_FAMILIES]
      .map(sanitizeSeed)
      .filter((s: string) => s.length >= 3 && s.length <= 80 && s.split(' ').length <= 10)
  )];
  console.log(`Seeding fresh discovery from ${seedSet.length} keywords...`);
  const ideas = await (svc as any).dataForSeoKeywordsForKeywords(seedSet) as Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }>;

  const seen = new Set<string>();
  const pool = [...ideas, ...backlogPool]
    .map((i) => ({ ...i, keyword: i.keyword.toLowerCase() }))
    .filter((i) => (i.volume ?? 0) >= 50 && (i.difficulty ?? 100) <= 60 && !claimed.has(i.keyword))
    .filter((i) => (seen.has(i.keyword) ? false : (seen.add(i.keyword), true)));
  console.log(`Ideas: ${ideas.length} + backlog: ${backlogPool.length} → validated unclaimed pool: ${pool.length}`);

  // ── Embedding match: candidate keyword must be topically CLOSE to the post's
  // existing content (this is the in-place-safety proxy — no redirect net here) ──
  const EMBED_FLOOR = 0.58;
  const postEmbedRows = await postgresPool.query(`SELECT entity_id, embedding FROM embeddings WHERE entity_type = 'post'`);
  const parseVec = (v: unknown): number[] | null => {
    if (Array.isArray(v)) return v as number[];
    if (typeof v === 'string') { try { return JSON.parse(v) as number[]; } catch { return null; } }
    return null;
  };
  const norm = (v: number[]) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); };
  const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
  const postVecById = new Map<string, number[]>();
  for (const row of postEmbedRows.rows as any[]) {
    const v = parseVec(row.embedding);
    if (v) postVecById.set(String(row.entity_id), norm(v));
  }
  console.log(`Post embeddings available: ${postVecById.size} / ${posts.length}`);

  console.log(`Embedding ${pool.length} candidate keywords...`);
  const poolVecs = await mapConcurrent(pool, 8, async (c) => {
    try { return { keyword: c.keyword, volume: c.volume, cpc: c.cpc, vec: norm(await gemini.embedText(c.keyword)) }; }
    catch { return null; }
  });
  const poolWithVecs = poolVecs.filter((p): p is NonNullable<typeof p> => p !== null);

  const taken = new Set<string>();
  const assignments: Array<{ post: any; candidates: Array<{ keyword: string; volume: number | null; cpc: number | null; score: number }> }> = [];
  const postsWithEmbeddings = posts.filter((p) => postVecById.has(String(p.id)));
  for (const p of postsWithEmbeddings) {
    const pVec = postVecById.get(String(p.id))!;
    const cands = poolWithVecs
      .filter((c) => !taken.has(c.keyword))
      .map((c) => ({ keyword: c.keyword, volume: c.volume, cpc: c.cpc, score: dot(pVec, c.vec) }))
      .filter((c) => c.score >= EMBED_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    if (cands[0]) taken.add(cands[0].keyword);
    assignments.push({ post: p, candidates: cands });
  }
  const withCandidates = assignments.filter((a) => a.candidates.length > 0);
  const noCandidate = assignments.filter((a) => a.candidates.length === 0);
  console.log(`Posts with a topically-close candidate: ${withCandidates.length} / ${postsWithEmbeddings.length} (no embedding at all: ${posts.length - postsWithEmbeddings.length})`);

  // ── Live SERP for each distinct top candidate ──
  const topKeywords = [...new Set(withCandidates.map((a) => a.candidates[0]!.keyword))];
  const serpByKeyword = new Map<string, Array<{ position: number; domain: string; title: string }>>();
  await mapConcurrent(topKeywords, 8, async (kw) => {
    try { serpByKeyword.set(kw, await svc.dataForSeoSerpTop(kw)); } catch { serpByKeyword.set(kw, []); }
  });

  // ── Judge — explicit indexed-page caution baked into the prompt ──
  const b = getBrandKnowledge();
  const caseStudies = JSON.parse(fs.readFileSync(path.resolve('data/case_studies.json'), 'utf8'));
  const proofList = caseStudies.case_studies.map((cs: any) => `${cs.id}: ${cs.title} (${cs.business_type})`).join('\n');
  const systemPrompt = `You decide whether to RETARGET an ALREADY-GOOGLE-INDEXED blog post onto a new keyword,
IN PLACE (same URL, same slug, same SERP title — only the body content pivots). There is no
redirect safety net for these decisions: a bad pivot risks an existing ranking, however small.

PURPOSE: Abdul wins when a GROWING-BUSINESS BUYER ($20k-$50k engagements — service business
owners, non-technical founders, ops leads) types a pain point into Google and reaches out.
NOT our buyer: enterprise procurement, job seekers, students, tool-shoppers.

REAL PROOF AVAILABLE: ${proofList}

For each post: its current (phantom-demand) title/topic, and ONE candidate replacement keyword
with real volume, CPC, Ads difficulty, live top-10 SERP, and an embedding similarity score against
the post's OWN current content (higher = more natural extension, lower = bigger topic jump).

Decide:
- "retarget": real buyer intent, winnable SERP (not authority/job-board/directory locked), AND the
  pivot is a credible, low-risk extension of what the page already covers — not a wholesale subject
  change. Because this is an indexed page with no redirect fallback, be MORE conservative here than
  you would for a non-indexed post: when genuinely torn, prefer "no_good_candidate".
- "no_good_candidate": wrong intent, unwinnable SERP, or too large a pivot to honestly/safely justify
  on a page Google already has indexed under the current topic.

CRITICAL CONSISTENCY RULE: your "reason" and "action" must agree — never write an approving reason
and mark "no_good_candidate" out of reflexive caution, and never mark "retarget" without filling in
"keyword" with the exact candidate string.

Return lead_value, a one-sentence reason, and a content_angle (brand voice: friction-first, calm
advisor, evidence over promises) for "retarget" decisions.
Return STRICT JSON {"decisions":[...]} — no fences.`;

  const items = withCandidates.map((a) => ({ a, kw: a.candidates[0]! }));
  const batchSize = 10;
  const batches: typeof items[] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));

  const batchResults = await mapConcurrent(batches, 6, async (batch) => {
    const payload = batch.map(({ a, kw }) => ({
      slug: a.post.slug,
      current_title: a.post.title,
      current_topic: a.post.primary_keyword,
      candidate_keyword: kw.keyword,
      volume: kw.volume, cpc: kw.cpc,
      embedding_similarity: Number(kw.score.toFixed(3)),
      serp_top10: (serpByKeyword.get(kw.keyword) ?? []).map((s) => `${s.position}. ${s.domain} — ${s.title.slice(0, 70)}`),
    }));
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await gemini.generateText({
          systemInstruction: systemPrompt,
          userPrompt: `INDEXED POSTS TO JUDGE (${batch.length}):\n${JSON.stringify(payload, null, 1)}\n\nReturn a decision for EVERY slug above.`,
          temperature: 0.3, maxOutputTokens: 8192,
        });
        const parsed = decisionSchema.parse(safeJsonParse(raw));
        return parsed.decisions.map((raw) => {
          const item = decisionItemSchema.safeParse(raw);
          if (!item.success) return { slug: (raw as any)?.slug ?? 'unknown', action: 'no_good_candidate' as const };
          const d = item.data;
          const hasKeyword = typeof d.keyword === 'string' && d.keyword.trim().length > 0;
          return { ...d, action: (d.action === 'retarget' && hasKeyword) ? 'retarget' as const : 'no_good_candidate' as const };
        });
      } catch (e) {
        if (attempt === 2) console.log(`⚠️ batch failed twice: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
      }
    }
    return [];
  });
  const decisions = batchResults.flat();

  const retarget = decisions.filter((d) => d.action === 'retarget' && d.keyword);
  const noGood = decisions.filter((d) => d.action === 'no_good_candidate');

  const outDir = path.resolve('review');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'phantom-indexed-remap-plan.json'), JSON.stringify({
    totalIndexedCandidates: (rows as any[]).length,
    alreadyReal: alreadyReal.map((r) => ({ slug: r.slug, keyword: r.primary_keyword })),
    retarget, noGood,
    noCandidateSlugs: noCandidate.map((a) => a.post.slug),
    noEmbeddingSlugs: posts.filter((p) => !postVecById.has(String(p.id))).map((p) => p.slug),
  }, null, 2));

  const md: string[] = [];
  md.push(`# Phantom-Keyword Remap Plan — INDEXED subset (in-place only)\n`);
  md.push(`Indexed candidates: ${(rows as any[]).length} | already-real (no action): ${alreadyReal.length} | genuinely phantom: ${posts.length}`);
  md.push(`RETARGET (safe pivot found): ${retarget.length} | NO GOOD CANDIDATE: ${noGood.length} | no topical candidate at all: ${noCandidate.length}\n`);
  md.push(`\n## RETARGET — will be rewritten in place, same URL (${retarget.length})\n`);
  md.push(`| Slug | Current topic | New keyword | Vol | CPC | Sim | Angle |\n|---|---|---|---|---|---|---|`);
  for (const d of retarget) {
    const it = items.find((it) => it.a.post.slug === d.slug);
    const kwData = it?.kw;
    md.push(`| ${d.slug} | ${it?.a.post.primary_keyword ?? ''} | ${d.keyword} | ${kwData?.volume ?? '?'} | $${kwData?.cpc ?? '?'} | ${kwData?.score.toFixed(2) ?? '?'} | ${(d.content_angle ?? '').slice(0, 90)} |`);
  }
  md.push(`\n## NOT POSSIBLE without ranking risk (${noGood.length + noCandidate.length})\n`);
  md.push(`No safe in-place pivot found — left untouched, ranking preserved as-is.\n`);
  md.push(`| Slug | Current topic | Why |\n|---|---|---|`);
  for (const d of noGood) {
    const it = items.find((it) => it.a.post.slug === d.slug);
    md.push(`| ${d.slug} | ${it?.a.post.primary_keyword ?? ''} | ${(d.reason ?? 'no viable low-risk candidate').slice(0, 90)} |`);
  }
  for (const a of noCandidate) {
    md.push(`| ${a.post.slug} | ${a.post.primary_keyword ?? ''} | no keyword in the pool is topically close enough (embedding < ${EMBED_FLOOR}) |`);
  }
  fs.writeFileSync(path.join(outDir, 'phantom-indexed-remap-plan.md'), md.join('\n'));
  fs.writeFileSync(path.join(outDir, 'phantom-indexed-approved-slugs.json'), JSON.stringify(retarget.map((d) => ({ slug: d.slug, keyword: d.keyword })), null, 2));

  console.log(`\n══ PLAN ══`);
  console.log(`RETARGET (in-place, safe): ${retarget.length} | NOT POSSIBLE: ${noGood.length + noCandidate.length}`);
  console.log(`Written: review/phantom-indexed-remap-plan.md + .json + phantom-indexed-approved-slugs.json`);
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
