/**
 * REMAP PLANNER — turn keyword-cannibalizing duplicates into pages that each
 * hunt a DIFFERENT buyer.
 *
 * For every keyword with multiple published posts on a site: the canonical
 * keeps the keyword; every duplicate gets one of three futures:
 *   REPURPOSE    — slug fits an unclaimed validated keyword → retarget + realign in place
 *   REDIRECT+NEW — a keyword validates but the slug doesn't fit → 301 the old URL to its
 *                  canonical, create a NEW correctly-slugged post for the keyword
 *   MERGE-ONLY   — no keyword validates → 301 to canonical, no new post
 *
 * This script PLANS only (writes review/remap-plan.{md,json}); execution is a
 * separate reviewed step.
 *
 *   npx tsx scripts/remap-planner.ts             # full plan
 *   npx tsx scripts/remap-planner.ts 10          # cap duplicates (test run)
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
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { KeywordService } from '../src/services/keywordService.js';
import { getBrandKnowledge } from '../src/knowledge/brandKnowledge.js';
import { safeJsonParse } from '../src/utils/json.js';

interface DupPost {
  id: string;
  slug: string;
  title: string;
  keyword: string;
  domain: string;
  websiteId: string;
  indexState: string | null;
  impressions: number;
  canonicalSlug: string;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'your', 'you', 'with', 'how', 'why', 'what', 'is', 'are', 'that', 'this', 'from', 'it', 'small', 'business', 'services', 'software', 'development', 'company', 'solutions']);
function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

const verdictSchema = z.object({
  decisions: z.array(z.object({
    slug: z.string(),
    action: z.enum(['repurpose', 'redirect_new', 'merge_only']),
    chosen_keyword: z.string().nullish(),
    slug_fit: z.enum(['good', 'poor']).nullish(),
    reason: z.string().nullish(),
    content_angle: z.string().nullish()
  })).min(1)
});

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

  // ── 1. Duplicate groups + canonical selection (indexed > impressions > freshest) ──
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT p.id, p.slug, p.title, LOWER(TRIM(p.primary_keyword)) AS kw, p.index_state, p.website_id, w.domain,
            COALESCE((SELECT SUM(m.total_impr) FROM gsc_page_metrics m WHERE m.post_id = p.id), 0) AS impr,
            p.updated_at
       FROM posts p JOIN websites w ON w.id = p.website_id
      WHERE p.status = 'published' AND p.primary_keyword IS NOT NULL AND p.primary_keyword != ''
      ORDER BY kw, (p.index_state = 'indexed') DESC, impr DESC, p.updated_at DESC`
  );
  const groups = new Map<string, any[]>();
  for (const r of rows as any[]) {
    const key = `${r.website_id}|${r.kw}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const duplicates: DupPost[] = [];
  const claimed = new Set<string>();
  for (const g of groups.values()) {
    claimed.add(String(g[0].kw)); // canonical keeps its keyword
    for (const d of g.slice(1)) {
      duplicates.push({
        id: String(d.id), slug: String(d.slug), title: String(d.title), keyword: String(d.kw),
        domain: String(d.domain), websiteId: String(d.website_id), indexState: d.index_state,
        impressions: Number(d.impr), canonicalSlug: String(g[0].slug),
      });
    }
  }
  const work = duplicates.slice(0, cap === Infinity ? undefined : cap);
  console.log(`Duplicate posts to plan: ${work.length} (of ${duplicates.length}) across ${groups.size} keyword groups`);

  // ── 2. Idea pool: seeds = duplicate keywords + brand sweet spots, with real metrics ──
  const b = getBrandKnowledge();
  const BRAND_SEED_KEYWORDS = [
    'online booking system for small business', 'workflow automation for small business',
    'custom crm for real estate agents', 'client intake automation', 'ai assistant for small business',
    'software for property management company', 'connect crm to scheduling software',
    'custom software for growing business', 'mvp development for startups', 'hire software development partner',
  ];
  // Google Ads rejects punctuation-heavy or >10-word seeds, and one bad seed can
  // fail a whole task — sanitize everything to keyword form first.
  const sanitizeSeed = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const seedSet = [...new Set(
    [...work.map((d) => d.keyword), ...BRAND_SEED_KEYWORDS, ...b.target_market.sweet_spot_problems]
      .map(sanitizeSeed)
      .filter((s) => s.length >= 3 && s.length <= 80 && s.split(' ').length <= 10)
  )].slice(0, 60);
  const ideas: Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }> = [];
  for (let i = 0; i < seedSet.length; i += 20) {
    try {
      const chunk = await (svc as any).dataForSeoKeywordsForKeywords(seedSet.slice(i, i + 20));
      ideas.push(...chunk);
    } catch (e) {
      console.log(`⚠️ ideas chunk failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`Raw ideas returned: ${ideas.length}`);
  const pool = ideas
    .filter((i) => (i.volume ?? 0) >= 50 && (i.difficulty ?? 100) <= 60 && !claimed.has(i.keyword.toLowerCase()))
    .map((i) => ({ ...i, keyword: i.keyword.toLowerCase(), toks: tokens(i.keyword) }));
  // dedupe pool by keyword
  const seen = new Set<string>();
  const uniquePool = pool.filter((p) => (seen.has(p.keyword) ? false : (seen.add(p.keyword), true)));
  console.log(`Validated unclaimed keyword pool: ${uniquePool.length} (volume ≥ 50, difficulty ≤ 60)`);

  // ── 3. Deterministic candidate matching + sequential assignment (uniqueness enforced) ──
  const assignments: Array<DupPost & { candidates: Array<{ keyword: string; volume: number | null; cpc: number | null; score: number }> }> = [];
  const taken = new Set<string>();
  // Highest-traffic duplicates pick first
  for (const d of [...work].sort((a, z2) => z2.impressions - a.impressions)) {
    const dToks = tokens(`${d.slug.replace(/-/g, ' ')} ${d.title} ${d.keyword}`);
    const cands = uniquePool
      .filter((p) => !taken.has(p.keyword))
      .map((p) => {
        const ov = overlap(dToks, p.toks);
        return { keyword: p.keyword, volume: p.volume, cpc: p.cpc, ov, score: ov * 10 + Math.min(p.cpc ?? 0, 100) / 10 };
      })
      // CPC is a tiebreaker, never a substitute for topical fit: require ≥2 shared tokens
      .filter((c) => c.ov >= 2)
      .sort((a, z2) => z2.score - a.score)
      .slice(0, 3);
    if (cands[0]) taken.add(cands[0].keyword); // provisional claim for the top candidate
    assignments.push({ ...d, candidates: cands });
  }

  // ── 4. DeepSeek: final action + slug-fit judgment per duplicate ──
  const systemPrompt = `You decide the future of duplicate blog posts. Abdul's business: $20k-$50k custom software
engagements for growing businesses (owners, non-technical founders, ops leads). Every post must
target ONE unclaimed buyer keyword, in brand voice.

For each duplicate you receive: its slug (IMMUTABLE — this URL cannot change), title, the keyword
it currently duplicates, and up to 3 candidate replacement keywords (validated real demand).

Decide ONE action:
- "repurpose": the TOP viable candidate keyword reads naturally against the existing slug (a
  visitor seeing this URL for that keyword would not be confused). Provide chosen_keyword,
  slug_fit="good", and a one-line brand-voice content angle.
- "redirect_new": a candidate keyword is commercially strong BUT the slug clearly mismatches it
  (slug promises a different topic). The old URL will 301 to its canonical; a NEW post with a
  proper slug will target the keyword. Provide chosen_keyword, slug_fit="poor", angle.
- "merge_only": no candidate is a sensible buyer keyword for this post. No keyword assigned.

Reject candidates with tool-shopping or job-seeker intent. Enterprise-scale topics (defense, bank
compliance, pharma) are never chosen. Return STRICT JSON {"decisions":[...]} — no fences.`;

  const decisions: Array<z.infer<typeof verdictSchema>['decisions'][number]> = [];
  for (let i = 0; i < assignments.length; i += 12) {
    const batch = assignments.slice(i, i + 12);
    const payload = batch.map((d) => ({
      slug: d.slug, title: d.title, duplicates_keyword: d.keyword,
      index_state: d.indexState, impressions: d.impressions,
      candidates: d.candidates.map((c) => ({ keyword: c.keyword, volume: c.volume, cpc: c.cpc })),
    }));
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await gemini.generateText({
          systemInstruction: systemPrompt,
          userPrompt: `DUPLICATE POSTS (${batch.length}):\n${JSON.stringify(payload, null, 1)}\n\nReturn a decision for EVERY slug above.`,
          temperature: 0.3,
          maxOutputTokens: 8192,
        });
        decisions.push(...verdictSchema.parse(safeJsonParse(raw)).decisions);
        break;
      } catch (e) {
        if (attempt === 2) console.log(`⚠️ batch ${i / 12 + 1} failed twice: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
      }
    }
    console.log(`  planned: ${Math.min(i + 12, assignments.length)}/${assignments.length}`);
  }

  // Enforce final keyword uniqueness across decisions (first decision wins)
  const finalTaken = new Set<string>();
  for (const d of decisions) {
    if (d.chosen_keyword) {
      const k = d.chosen_keyword.toLowerCase();
      if (finalTaken.has(k) || claimed.has(k)) {
        d.action = 'merge_only';
        d.chosen_keyword = null;
        d.reason = `${d.reason ?? ''} [keyword already assigned — demoted to merge]`.trim();
      } else {
        finalTaken.add(k);
      }
    }
  }

  // ── 5. Emit plan ──
  const bySlug = new Map(assignments.map((a) => [a.slug, a]));
  const outDir = path.resolve('review');
  const count = (a: string) => decisions.filter((d) => d.action === a).length;
  fs.writeFileSync(path.join(outDir, 'remap-plan.json'), JSON.stringify({ decisions, duplicates: assignments }, null, 2));

  // High-value pool keywords nobody claimed → recommended as NEW posts (fresh
  // slugs), pending research-agent validation. This is the user's redirect+new
  // path generalized: merged old URLs 301 to canonicals; strong keywords get
  // purpose-built pages instead of being forced onto mismatched slugs.
  const newPostCandidates = uniquePool
    .filter((p) => !finalTaken.has(p.keyword))
    .sort((a, z2) => (z2.cpc ?? 0) - (a.cpc ?? 0))
    .slice(0, 25);

  const md: string[] = [];
  md.push(`# Remap Plan — duplicate posts to distinct buyer keywords\n`);
  md.push(`Duplicates planned: ${decisions.length} | REPURPOSE: ${count('repurpose')} | REDIRECT+NEW: ${count('redirect_new')} | MERGE-ONLY: ${count('merge_only')}\n`);
  md.push(`\n## NEW-POST CANDIDATES (top unclaimed keywords — validate via research agent before writing)\n`);
  md.push(`| Keyword | Vol/mo | CPC |\n|---|---|---|`);
  for (const p of newPostCandidates) md.push(`| ${p.keyword} | ${p.volume} | $${p.cpc ?? '?'} |`);

  for (const action of ['repurpose', 'redirect_new', 'merge_only'] as const) {
    md.push(`\n## ${action.toUpperCase().replace('_', '+')} (${count(action)})\n`);
    md.push(`| Post | Currently duplicates | New keyword (vol, CPC) | Why |\n|---|---|---|---|`);
    for (const d of decisions.filter((x) => x.action === action)) {
      const a = bySlug.get(d.slug);
      const cand = a?.candidates.find((c) => c.keyword === (d.chosen_keyword ?? '')?.toLowerCase());
      md.push(`| /${d.slug} | ${a?.keyword ?? '?'} | ${d.chosen_keyword ? `${d.chosen_keyword} (${cand?.volume ?? '?'}, $${cand?.cpc ?? '?'})` : '—'} | ${(d.reason ?? '').slice(0, 140)} |`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'remap-plan.md'), md.join('\n'));

  console.log(`\n══ PLAN ══`);
  console.log(`REPURPOSE: ${count('repurpose')} | REDIRECT+NEW: ${count('redirect_new')} | MERGE-ONLY: ${count('merge_only')}`);
  console.log(`Written: review/remap-plan.md + review/remap-plan.json`);
  await mysqlPool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
