/**
 * RELAXED-FIT RETARGET — for indexed phantom-keyword posts where a topically-close
 * pivot ISN'T available (phantom-remap-indexed.ts already found and executed those).
 * User's explicit instruction (2026-07-28): for the remaining posts, find ANY real
 * buyer-intent keyword that could bring views, even if it doesn't fit the post's
 * current content or the brand's usual sweet spot — traffic over topical purity.
 * Brand VOICE still applies (goes through the same brand-refresh-indexed.ts rewrite),
 * only the topical-fit gate is relaxed. Same URL, same title — still in-place, still
 * no redirect (these ARE indexed, no safety net).
 *
 * SEMANTIC DEDUP IS STILL MANDATORY: without a fit floor, many posts gravitate to the
 * same handful of high-scoring generic terms (exactly what happened in the indexed-fit
 * run: 12/17 candidates were "legacy modernization" variants). A normalize+bucket pass
 * keeps only the single best-fit-by-CPC winner per semantic cluster; the rest degrade
 * to no_good_candidate rather than executing and cannibalizing.
 *
 *   npx tsx scripts/phantom-remap-relaxed.ts <slugs-file>
 */
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

const TRAILING_MODIFIERS = new Set(['services', 'service', 'solutions', 'solution', 'strategies', 'strategy', 'approach', 'approaches', 'company', 'companies', 'firm', 'firms', 'partner', 'partners', 'provider', 'providers', 'consulting', 'consultants']);
function normalizeKeyword(kw: string): string {
  const words = kw.toLowerCase()
    .replace(/isation/g, 'ization')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w))
    .filter((w) => !TRAILING_MODIFIERS.has(w) && w.length > 2 && w !== 'for');
  return [...new Set(words)].sort().join(' ');
}

async function main() {
  const slugsFile = process.argv[2];
  if (!slugsFile) throw new Error('usage: phantom-remap-relaxed.ts <slugs-file>');
  const slugs = fs.readFileSync(slugsFile, 'utf8').trim().split('\n').filter(Boolean);

  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  const gemini = new GeminiClient({
    rateLimiter: new GeminiRateLimiter(mysqlPool, apiKeys),
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_PROVIDER === 'openrouter' ? 0 : env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
  const svc = new KeywordService({ pool: mysqlPool, gemini });
  if (!svc.dataForSeoEnabled()) throw new Error('DataForSEO credentials missing');

  const placeholders = slugs.map(() => '?').join(',');
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT p.id, p.slug, p.title, p.primary_keyword, p.website_id, w.domain, p.index_state
       FROM posts p JOIN websites w ON w.id = p.website_id
      WHERE p.slug IN (${placeholders}) AND p.status = 'published' AND p.index_state = 'indexed'`,
    slugs
  );
  const posts = rows as any[];
  console.log(`Requested: ${slugs.length} | still published+indexed: ${posts.length}`);

  // Re-verify current keyword still phantom (catches any that already got fixed elsewhere).
  const sanitizeSeed = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const currentKwList = [...new Set(posts.map((r) => sanitizeSeed(String(r.primary_keyword || ''))).filter((s) => s.length >= 3))];
  const currentVolMap = await svc.dataForSeoSearchVolume(currentKwList);
  const realVolByKw = new Map([...currentVolMap.entries()].map(([kw, m]) => [kw.toLowerCase(), m.volume ?? 0]));
  const phantomPosts = posts.filter((r) => (realVolByKw.get(sanitizeSeed(String(r.primary_keyword || ''))) ?? 0) < 50);
  console.log(`Genuinely phantom (fresh-verified): ${phantomPosts.length} | already real: ${posts.length - phantomPosts.length}`);

  const [ownedRows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT DISTINCT LOWER(TRIM(primary_keyword)) AS kw FROM posts WHERE status='published' AND primary_keyword IS NOT NULL`
  );
  const claimed = new Set((ownedRows as any[]).map((r) => String(r.kw)));

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
    'api integration services', 'software development cost', 'hire software developer',
    'outsource software development', 'custom web application development',
    'startup technical advisor', 'reduce technical debt', 'software audit services',
  ];
  let backlogPool: Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }> = [];
  try {
    const backlog = JSON.parse(fs.readFileSync(path.resolve('review/verified-keyword-backlog.json'), 'utf8'));
    backlogPool = backlog.backlog ?? [];
  } catch { /* optional */ }

  const seedSet = [...new Set(
    [...phantomPosts.map((p) => p.primary_keyword || p.title), ...BRAND_SEED_FAMILIES]
      .map(sanitizeSeed)
      .filter((s: string) => s.length >= 3 && s.length <= 80 && s.split(' ').length <= 10)
  )];
  console.log(`Seeding fresh discovery from ${seedSet.length} keywords...`);
  const ideas = await (svc as any).dataForSeoKeywordsForKeywords(seedSet) as Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }>;

  const seen = new Set<string>();
  const pool = [...ideas, ...backlogPool]
    .map((i) => ({ ...i, keyword: i.keyword.toLowerCase() }))
    .filter((i) => (i.volume ?? 0) >= 50 && (i.difficulty ?? 100) <= 65 && !claimed.has(i.keyword))
    .filter((i) => (seen.has(i.keyword) ? false : (seen.add(i.keyword), true)));
  console.log(`Ideas: ${ideas.length} + backlog: ${backlogPool.length} → validated unclaimed pool: ${pool.length}`);

  // NO embedding floor this round — topical fit is explicitly waived. Every post
  // still gets matched against the pool by embedding score purely to RANK candidates
  // (best-fit-available, even if the absolute score is low), not to gate them out.
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

  console.log(`Embedding ${pool.length} candidate keywords...`);
  const poolVecs = await mapConcurrent(pool, 8, async (c) => {
    try { return { keyword: c.keyword, volume: c.volume, cpc: c.cpc, vec: norm(await gemini.embedText(c.keyword)) }; }
    catch { return null; }
  });
  const poolWithVecs = poolVecs.filter((p): p is NonNullable<typeof p> => p !== null);

  const taken = new Set<string>();
  const assignments: Array<{ post: any; candidates: Array<{ keyword: string; volume: number | null; cpc: number | null; score: number }> }> = [];
  const postsWithEmbeddings = phantomPosts.filter((p) => postVecById.has(String(p.id)));
  for (const p of postsWithEmbeddings) {
    const pVec = postVecById.get(String(p.id))!;
    const cands = poolWithVecs
      .filter((c) => !taken.has(c.keyword))
      .map((c) => ({ keyword: c.keyword, volume: c.volume, cpc: c.cpc, score: dot(pVec, c.vec) }))
      .sort((a, b) => (b.cpc ?? 0) - (a.cpc ?? 0)) // relaxed fit: rank by buyer value (CPC) first, not similarity
      .slice(0, 30)
      .sort((a, b) => b.score - a.score) // then take the best-fitting among the top-CPC options
      .slice(0, 2);
    if (cands[0]) taken.add(cands[0].keyword);
    assignments.push({ post: p, candidates: cands });
  }
  const withCandidates = assignments.filter((a) => a.candidates.length > 0);
  const noCandidate = assignments.filter((a) => a.candidates.length === 0);
  console.log(`Posts with a candidate: ${withCandidates.length} / ${postsWithEmbeddings.length} (no embedding: ${phantomPosts.length - postsWithEmbeddings.length})`);

  const topKeywords = [...new Set(withCandidates.map((a) => a.candidates[0]!.keyword))];
  const serpByKeyword = new Map<string, Array<{ position: number; domain: string; title: string }>>();
  await mapConcurrent(topKeywords, 8, async (kw) => {
    try { serpByKeyword.set(kw, await svc.dataForSeoSerpTop(kw)); } catch { serpByKeyword.set(kw, []); }
  });

  const caseStudies = JSON.parse(fs.readFileSync(path.resolve('data/case_studies.json'), 'utf8'));
  const proofList = caseStudies.case_studies.map((cs: any) => `${cs.id}: ${cs.title} (${cs.business_type})`).join('\n');
  const systemPrompt = `You decide whether to RETARGET an ALREADY-GOOGLE-INDEXED blog post onto a new keyword,
IN PLACE (same URL, same slug, same SERP title — only the body content pivots, and it may pivot
SUBSTANTIALLY away from the post's current topic). There is no redirect safety net.

CONTEXT: this post currently targets phantom demand (effectively zero real search volume) — it
gets no traffic no matter what. The owner has explicitly decided TRAFFIC now outranks topical
purity or brand-niche fit for this batch: even a keyword that doesn't fit the post's current
enterprise-flavored topic, or isn't a perfect fit for the usual growing-business ICP, is worth
taking if it's REAL, WINNABLE demand that could bring visitors to the site. Do NOT reject purely
because the pivot is a big topic change — that is expected and accepted here.

STILL REJECT if:
- The keyword has NO real commercial/informational value for this business at all (e.g. wrong
  industry entirely with no plausible service angle, adult/gambling/unrelated verticals).
- The SERP is fully authority-locked (Wikipedia, government, massive-brand-only top 10) with no
  realistic path to ever rank.
- The candidate is a bare product-category term ("X software", "X app", "X platform") whose SERP
  is dominated by tool vendors — that's proven tool-shopper intent, not a lead for a service
  business, regardless of CPC.

REAL PROOF AVAILABLE (use if the pivot allows a credible angle, skip if not): ${proofList}

Return lead_value, a one-sentence reason, and a content_angle for "retarget" decisions.
CRITICAL CONSISTENCY RULE: reason and action must agree; never mark "retarget" without filling in
"keyword" with the exact candidate string.
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
  const rawRetarget = decisions.filter((d) => d.action === 'retarget' && d.keyword);
  const noGood = decisions.filter((d) => d.action === 'no_good_candidate');

  // ── SEMANTIC DEDUP — mandatory, not optional (see file header) ──
  const kwDataBySlug = new Map(items.map((it) => [it.a.post.slug, it.kw]));
  const buckets = new Map<string, typeof rawRetarget>();
  for (const d of rawRetarget) {
    const bucket = normalizeKeyword(d.keyword!);
    const arr = buckets.get(bucket) ?? [];
    arr.push(d);
    buckets.set(bucket, arr);
  }
  const winners: typeof rawRetarget = [];
  const deferred: Array<{ slug: string; keyword: string; reason: string }> = [];
  for (const [, group] of buckets) {
    const sorted = group.sort((a, b) => (kwDataBySlug.get(b.slug)?.cpc ?? 0) - (kwDataBySlug.get(a.slug)?.cpc ?? 0));
    winners.push(sorted[0]!);
    for (const loser of sorted.slice(1)) {
      deferred.push({ slug: loser.slug, keyword: loser.keyword!, reason: `deferred — near-duplicate keyword cluster with "${sorted[0]!.slug}" ("${sorted[0]!.keyword}"), which won on CPC` });
    }
  }
  console.log(`\nSemantic dedup: ${rawRetarget.length} raw retargets → ${winners.length} winners (${deferred.length} deferred as cannibalization risk)`);

  const outDir = path.resolve('review');
  fs.writeFileSync(path.join(outDir, 'phantom-relaxed-plan.json'), JSON.stringify({
    requested: slugs.length, stillIndexedPhantom: phantomPosts.length,
    winners, deferred, noGood, noCandidateSlugs: noCandidate.map((a) => a.post.slug),
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'phantom-relaxed-approved-slugs.json'), JSON.stringify(winners.map((d) => ({ slug: d.slug, keyword: d.keyword })), null, 2));

  const md: string[] = [`# Relaxed-fit retarget plan (traffic over topical fit)\n`,
    `Requested: ${slugs.length} | still indexed+phantom: ${phantomPosts.length}`,
    `RETARGET (winners, deduped): ${winners.length} | deferred (cannibalization risk): ${deferred.length} | judge rejected: ${noGood.length} | no candidate at all: ${noCandidate.length}\n`,
    `\n## WINNERS (${winners.length})\n|Slug|Current|New keyword|Vol|CPC|\n|---|---|---|---|---|`];
  for (const d of winners) {
    const kw = kwDataBySlug.get(d.slug);
    md.push(`| ${d.slug} | ${items.find((i) => i.a.post.slug === d.slug)?.a.post.primary_keyword} | ${d.keyword} | ${kw?.volume ?? '?'} | $${kw?.cpc ?? '?'} |`);
  }
  fs.writeFileSync(path.join(outDir, 'phantom-relaxed-plan.md'), md.join('\n'));

  console.log(`\n== PLAN ==\nWINNERS to execute: ${winners.length}`);
  console.log(`Written: review/phantom-relaxed-plan.md + .json + phantom-relaxed-approved-slugs.json`);
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
