/**
 * PHANTOM-KEYWORD REMAP — find a REAL, validated buyer keyword for every
 * published post currently targeting phantom demand (0 search volume), and
 * produce a plan to retarget + realign it. Parallelized at every stage.
 *
 * PURPOSE: content honestly written in brand voice is still worthless if
 * nobody searches for what it targets. This closes that gap at corpus scale.
 *
 *   npx tsx scripts/phantom-remap.ts            # full run
 *   npx tsx scripts/phantom-remap.ts 20         # cap posts (test)
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

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'your', 'you', 'with', 'how', 'why', 'what', 'is', 'are', 'that', 'this', 'from', 'it', 'unless', 'these', 'those', 'not', 'just', 'small', 'business', 'services', 'software', 'development', 'company']);
function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0; for (const x of a) if (b.has(x)) n++; return n;
}

const decisionItemSchema = z.object({
  slug: z.string(),
  action: z.enum(['retarget', 'no_good_candidate']).nullish(),
  keyword: z.string().nullish(),
  lead_value: z.enum(['high', 'medium', 'low']).nullish(),
  reason: z.string().nullish(),
  content_angle: z.string().nullish()
});
const decisionSchema = z.object({ decisions: z.array(z.unknown()).min(1) });

async function main() {
  const cap = Number(process.argv[2] ?? 0) || Infinity;
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  const gemini = new GeminiClient({
    rateLimiter: new GeminiRateLimiter(mysqlPool, apiKeys),
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_PROVIDER === 'openrouter' ? 0 : env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
  const svc = new KeywordService({ pool: mysqlPool, gemini });
  if (!svc.dataForSeoEnabled()) throw new Error('DataForSEO credentials missing');

  // ── 1. Load phantom posts: published, real metrics say 0/unknown volume ──
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT p.id, p.slug, p.title, p.primary_keyword, p.website_id, w.domain, p.index_state,
            COALESCE((SELECT SUM(m.total_impr) FROM gsc_page_metrics m WHERE m.post_id = p.id), 0) AS impr,
            k.volume
       FROM posts p JOIN websites w ON w.id = p.website_id
       LEFT JOIN keywords k ON LOWER(TRIM(k.keyword)) = LOWER(TRIM(p.primary_keyword))
      WHERE p.status = 'published' AND (k.volume IS NULL OR k.volume = 0)
      ORDER BY impr DESC`
  );
  const posts = (rows as any[]).slice(0, cap === Infinity ? undefined : cap);
  console.log(`Phantom posts to remap: ${posts.length}`);

  // ── 2. Every keyword any published post already owns — never reassign onto these ──
  const [ownedRows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT DISTINCT LOWER(TRIM(primary_keyword)) AS kw FROM posts WHERE status='published' AND primary_keyword IS NOT NULL`
  );
  const claimed = new Set((ownedRows as any[]).map((r) => String(r.kw)));

  // ── 3. Discovery: each post's own keyword/title is a seed → real-metric ideas ──
  // Google Ads silently drops/fails seeds over 10 words or with stray punctuation —
  // prefer the existing (short, query-shaped) primary_keyword; fall back to a
  // trimmed title only when no primary_keyword exists.
  const sanitizeSeed = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  // Per-post seeds alone regress toward the corpus's own enterprise/tool-shopping
  // flavor (an enterprise seed's "related keywords" are more enterprise keywords).
  // Mix in the brand's proven-winnable service-intent families so the pool has
  // real alternatives to match phantom posts against, not just more of the same.
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
  ];
  const seedSet = [...new Set(
    [...posts.map((p) => p.primary_keyword || p.title), ...BRAND_SEED_FAMILIES]
      .map(sanitizeSeed)
      .filter((s: string) => s.length >= 3 && s.length <= 80 && s.split(' ').length <= 10)
  )];
  console.log(`Seeding discovery from ${seedSet.length} keywords (${posts.length} per-post + ${BRAND_SEED_FAMILIES.length} brand-family, word-count filtered)...`);
  const ideas = await (svc as any).dataForSeoKeywordsForKeywords(seedSet) as Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }>;
  const seen = new Set<string>();
  const pool = ideas
    .map((i) => ({ ...i, keyword: i.keyword.toLowerCase() }))
    .filter((i) => (i.volume ?? 0) >= 50 && (i.difficulty ?? 100) <= 60 && !claimed.has(i.keyword))
    .filter((i) => (seen.has(i.keyword) ? false : (seen.add(i.keyword), true)))
    .map((i) => ({ ...i, toks: tokens(i.keyword) }));
  console.log(`Ideas returned: ${ideas.length} → validated unclaimed candidate pool: ${pool.length}`);

  // ── 4. Semantic matching via embeddings (token overlap misses too much: an
  // enterprise-flavored post title and a brand-family keyword phrase are often
  // genuinely related but share zero literal words) ──
  const EMBED_FLOOR = 0.58;
  const postEmbedRows = await postgresPool.query(
    `SELECT entity_id, embedding FROM embeddings WHERE entity_type = 'post'`
  );
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
  const assignments: Array<{ post: any; candidates: Array<{ keyword: string; volume: number | null; cpc: number | null }> }> = [];
  const postsWithEmbeddings = posts.filter((p) => postVecById.has(String(p.id)));
  console.log(`Matching ${postsWithEmbeddings.length} posts against ${poolWithVecs.length} embedded candidates (floor ${EMBED_FLOOR})...`);
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
  console.log(`Posts with at least one candidate match: ${withCandidates.length} / ${posts.length}`);

  // ── 5. Live SERP for each distinct top candidate (parallel) ──
  const topKeywords = [...new Set(withCandidates.map((a) => a.candidates[0]!.keyword))];
  const serpByKeyword = new Map<string, Array<{ position: number; domain: string; title: string }>>();
  let serpDone = 0;
  await mapConcurrent(topKeywords, 8, async (kw) => {
    try {
      serpByKeyword.set(kw, await svc.dataForSeoSerpTop(kw));
    } catch { serpByKeyword.set(kw, []); }
    serpDone++;
    if (serpDone % 30 === 0) console.log(`  SERP: ${serpDone}/${topKeywords.length}`);
  });

  // ── 6. REASON: DeepSeek judges each (post, candidate keyword) pair, in parallel batches ──
  const b = getBrandKnowledge();
  const caseStudies = JSON.parse(fs.readFileSync(path.resolve('data/case_studies.json'), 'utf8'));
  const proofList = caseStudies.case_studies.map((cs: any) => `${cs.id}: ${cs.title} (${cs.business_type})`).join('\n');
  const systemPrompt = `You decide whether to RETARGET an existing blog post onto a new keyword.

PURPOSE: Abdul wins when a GROWING-BUSINESS BUYER ($20k-$50k engagements — service business
owners, non-technical founders, ops leads) types a pain point into Google and reaches out.
NOT our buyer: enterprise procurement, job seekers, students, tool-shoppers.

REAL PROOF AVAILABLE: ${proofList}

For each post you receive: its current (phantom-demand, worthless) title/topic, and ONE
candidate replacement keyword with real volume, CPC, Ads difficulty, and its live top-10 SERP.

Decide:
- "retarget": the candidate is real buyer-intent demand, winnable (SERP not authority/job-board/
  directory locked), and the post's EXISTING content angle can credibly pivot to serve it.
- "no_good_candidate": wrong intent, unwinnable SERP, or too large a topic pivot from the post's
  current content to honestly serve.

CRITICAL CONSISTENCY RULE: your "reason" text and your "action" must agree. If your reason argues
the keyword has real buyer intent, a winnable SERP, and the post can credibly pivot, your action
MUST be "retarget" — do not write an approving reason and then mark "no_good_candidate" out of
excess caution. Conversely, never mark "retarget" unless you also fill in "keyword" with the
exact candidate keyword string — a retarget with no keyword is invalid and will be discarded.
When your own reasoning is genuinely positive on intent, winnability, and pivot feasibility, favor
retarget; reserve "no_good_candidate" for cases where at least one of those three is a real problem.

Return lead_value, a one-sentence reason, and a content_angle (brand voice: friction-first, calm
advisor, evidence over promises) for "retarget" decisions.
Return STRICT JSON {"decisions":[...]} — no fences.`;

  const items = withCandidates.map((a) => ({ a, kw: a.candidates[0]! }));
  const batchSize = 10;
  const batches: typeof items[] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));

  let judged = 0;
  const batchResults = await mapConcurrent(batches, 6, async (batch) => {
    const payload = batch.map(({ a, kw }) => ({
      slug: a.post.slug,
      current_title: a.post.title,
      current_topic: a.post.primary_keyword,
      candidate_keyword: kw.keyword,
      volume: kw.volume, cpc: kw.cpc,
      serp_top10: (serpByKeyword.get(kw.keyword) ?? []).map((s) => `${s.position}. ${s.domain} — ${s.title.slice(0, 70)}`)
    }));
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await gemini.generateText({
          systemInstruction: systemPrompt,
          userPrompt: `POSTS TO JUDGE (${batch.length}):\n${JSON.stringify(payload, null, 1)}\n\nReturn a decision for EVERY slug above.`,
          temperature: 0.3, maxOutputTokens: 8192
        });
        const parsed = decisionSchema.parse(safeJsonParse(raw));
        judged += batch.length;
        console.log(`  judged: ${judged}/${items.length}`);
        // Validate each decision INDIVIDUALLY — one malformed item (e.g. a
        // retarget with no keyword) must not discard the whole batch's valid
        // decisions. A bad item degrades to reject rather than losing everyone.
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

  // ── OUTPUT ──
  const retarget = decisions.filter((d) => d.action === 'retarget' && d.keyword);
  const noGood = decisions.filter((d) => d.action === 'no_good_candidate');
  const noCandidate = assignments.filter((a) => a.candidates.length === 0);

  const outDir = path.resolve('review');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'phantom-remap-plan.json'), JSON.stringify({ retarget, noGood, noCandidateSlugs: noCandidate.map((a) => a.post.slug) }, null, 2));

  const md: string[] = [];
  md.push(`# Phantom-Keyword Remap Plan\n`);
  md.push(`Phantom posts scanned: ${posts.length} | RETARGET: ${retarget.length} | REJECTED (no good candidate): ${noGood.length} | NO CANDIDATE FOUND: ${noCandidate.length}\n`);
  md.push(`\n## RETARGET (${retarget.length})\n`);
  md.push(`| Slug | New keyword | Vol | CPC | Angle |\n|---|---|---|---|---|`);
  for (const d of retarget) {
    const kwData = items.find((it) => it.a.post.slug === d.slug)?.kw;
    md.push(`| ${d.slug} | ${d.keyword} | ${kwData?.volume ?? '?'} | $${kwData?.cpc ?? '?'} | ${(d.content_angle ?? '').slice(0, 100)} |`);
  }
  fs.writeFileSync(path.join(outDir, 'phantom-remap-plan.md'), md.join('\n'));

  // Slug list for the execution step
  fs.writeFileSync(path.join(outDir, 'phantom-remap-slugs.txt'), retarget.map((d) => d.slug).join('\n'));

  console.log(`\n══ PLAN ══`);
  console.log(`RETARGET: ${retarget.length} | REJECTED: ${noGood.length} | NO CANDIDATE: ${noCandidate.length}`);
  console.log(`Written: review/phantom-remap-plan.md + .json + phantom-remap-slugs.txt`);
  await mysqlPool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
