/**
 * KEYWORD RESEARCH AGENT v1 — gather-then-reason.
 *
 * PURPOSE (the only metric that matters): put Abdul's pages in front of buyers
 * typing their pain into Google, so they come to him — $20k–$50k engagements.
 * This agent decides WHICH keywords deserve content, so every writing hour goes
 * into pages that can (a) rank and (b) convert a buyer.
 *
 * How it works:
 *   GATHER (deterministic, no LLM): real volume/CPC/difficulty (from the demand
 *   audit), live SERP top-10 per keyword (who actually ranks — authority sites,
 *   directories, job boards, weak content), our GSC standing, our existing posts
 *   (cannibalization), plus replacement keyword IDEAS for the phantom corpus.
 *   REASON (DeepSeek, batched): judge each keyword against buyer intent, ICP fit,
 *   SERP winnability, and case-study proof → verdict + content angle.
 *
 *   npx tsx scripts/keyword-research-agent.ts            # full run
 *   npx tsx scripts/keyword-research-agent.ts 10         # cap candidates (test)
 *
 * Outputs:
 *   review/keyword-research-plan.md      — human-readable writing queue
 *   review/keyword-research-verdicts.json — machine-readable (feeds the rewrite waves)
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
import { mapConcurrent } from '../src/utils/concurrency.js';

const AUTHORITY = ['wikipedia.org', 'forbes.com', 'gartner.com', 'mckinsey.com', 'ibm.com', 'microsoft.com', 'aws.amazon.com', 'oracle.com', 'sap.com', 'salesforce.com', 'deloitte.com', 'accenture.com', 'hbr.org', 'techtarget.com', 'investopedia.com', 'coursera.org', 'atlassian.com', 'shopify.com'];
const WEAK = ['reddit.com', 'quora.com', 'medium.com', 'dev.to', 'stackoverflow.com', 'stackexchange.com'];
const JOB_BOARDS = ['indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'jobs.', 'careers.', 'linkedin.com/jobs'];
const DIRECTORIES = ['clutch.co', 'upwork.com', 'toptal.com', 'goodfirms.co', 'designrush.com', 'g2.com', 'trustpilot.com'];

interface Candidate {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  difficulty: number | null;
  source: 'existing-post' | 'idea';
  ourSlugs: string[];
  gsc: { position: number | null; impressions: number };
  serp: Array<{ position: number; domain: string; title: string }>;
  serpSignals: { authority: number; weak: number; jobBoards: boolean; directories: boolean };
}

// Nullable-tolerant: DeepSeek returns null for fields that don't apply to
// rejects (icp_fit, content_angle) — normalize after parsing instead of failing.
const verdictSchema = z.object({
  verdicts: z.array(z.object({
    keyword: z.string().min(1),
    verdict: z.enum(['priority', 'secondary', 'reject']),
    lead_value: z.enum(['high', 'medium', 'low']).nullish(),
    icp_fit: z.string().nullish(),
    buyer_journey_stage: z.enum(['awareness', 'consideration', 'decision', 'validation']).nullish(),
    reason: z.string().nullish(),
    content_angle: z.string().nullish(),
    canonical_slug: z.string().nullish()
  })).min(1)
});
interface Verdict {
  keyword: string;
  verdict: 'priority' | 'secondary' | 'reject';
  lead_value: 'high' | 'medium' | 'low';
  icp_fit: string;
  buyer_journey_stage: string;
  reason: string;
  content_angle: string;
  canonical_slug: string | null;
}

function serpSignals(serp: Candidate['serp']): Candidate['serpSignals'] {
  const has = (list: string[], d: string) => list.some((x) => d.includes(x));
  return {
    authority: serp.filter((s) => has(AUTHORITY, s.domain)).length,
    weak: serp.filter((s) => has(WEAK, s.domain)).length,
    jobBoards: serp.some((s) => has(JOB_BOARDS, s.domain)),
    directories: serp.some((s) => has(DIRECTORIES, s.domain))
  };
}

async function main() {
  const kwFlag = process.argv.indexOf('--keywords');
  const explicitKeywords = kwFlag >= 0
    ? String(process.argv[kwFlag + 1] ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
    : null;
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

  // ── DISCOVERY MODE: expand seed families into ideas, validate the best ────
  const seedFlag = process.argv.indexOf('--seeds');
  if (seedFlag >= 0) {
    const sanitizeSeed = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    const seeds = String(process.argv[seedFlag + 1] ?? '').split(',').map(sanitizeSeed)
      .filter((s) => s.length >= 3 && s.length <= 80 && s.split(' ').length <= 10);
    console.log(`Discovery from ${seeds.length} seeds`);

    // Every keyword a published post already owns is off the table.
    const [ownedRows] = await mysqlPool.query<RowDataPacket[]>(
      `SELECT DISTINCT LOWER(TRIM(primary_keyword)) AS kw FROM posts WHERE status = 'published' AND primary_keyword IS NOT NULL`
    );
    const claimed = new Set((ownedRows as any[]).map((r) => String(r.kw)));

    const ideas: Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }> = [];
    for (let i = 0; i < seeds.length; i += 20) {
      try {
        ideas.push(...await (svc as any).dataForSeoKeywordsForKeywords(seeds.slice(i, i + 20)));
      } catch (e) {
        console.log(`⚠️ ideas chunk failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const seenKw = new Set<string>();
    const poolCandidates = ideas
      .map((i) => ({ ...i, keyword: i.keyword.toLowerCase() }))
      .filter((i) => (i.volume ?? 0) >= 50 && (i.difficulty ?? 100) <= 60 && !claimed.has(i.keyword))
      .filter((i) => (seenKw.has(i.keyword) ? false : (seenKw.add(i.keyword), true)))
      .sort((a, z2) => (z2.cpc ?? 0) - (a.cpc ?? 0))
      .slice(0, cap === Infinity ? 40 : cap);
    console.log(`Ideas: ${ideas.length} → validated-metric unclaimed pool: ${seenKw.size} → validating top ${poolCandidates.length} by CPC`);

    const targeted: Candidate[] = poolCandidates.map((i) => ({
      keyword: i.keyword, volume: i.volume, cpc: i.cpc, difficulty: i.difficulty,
      source: 'idea' as const, ourSlugs: [],
      gsc: { position: null, impressions: 0 }, serp: [], serpSignals: { authority: 0, weak: 0, jobBoards: false, directories: false },
    }));
    return runValidation(targeted, gemini, svc, 'wave2-research-plan');
  }

  // ── TARGETED MODE: validate an explicit keyword list (e.g., remap-plan assignments) ──
  if (explicitKeywords && explicitKeywords.length > 0) {
    console.log(`Targeted validation of ${explicitKeywords.length} keywords`);
    const metrics = await svc.dataForSeoSearchVolume(explicitKeywords);
    const targeted: Candidate[] = [];
    for (const kw of explicitKeywords) {
      const m = metrics.get(kw);
      const [posts] = await mysqlPool.query<RowDataPacket[]>(
        `SELECT slug FROM posts WHERE LOWER(TRIM(primary_keyword)) = ? AND status = 'published'`, [kw]
      );
      targeted.push({
        keyword: kw, volume: m?.volume ?? null, cpc: m?.cpc ?? null, difficulty: m?.difficulty ?? null,
        source: 'idea', ourSlugs: (posts as any[]).map((p) => String(p.slug)),
        gsc: { position: null, impressions: 0 }, serp: [], serpSignals: { authority: 0, weak: 0, jobBoards: false, directories: false },
      });
    }
    // Fall through to SERP + judgment with this list only.
    return runValidation(targeted, gemini, svc, 'keyword-validation');
  }

  // ── GATHER 1: winnable keywords from the demand audit (existing posts) ────
  const auditCsv = fs.readFileSync(path.resolve('review/keyword-demand-audit.csv'), 'utf8').split('\n').slice(1);
  const byKeyword = new Map<string, Candidate>();
  for (const line of auditCsv) {
    const m = line.match(/^([^,]+),"((?:[^"]|"")*)",([^,]*),([^,]*),([^,]*),([^,]*),/);
    if (!m) continue;
    const keyword = m[2]!.replace(/""/g, '"').toLowerCase();
    const volume = m[3] ? Number(m[3]) : null;
    const cpc = m[4] ? Number(m[4]) : null;
    const difficulty = m[5] ? Number(m[5]) : null;
    const slug = new URL(m[1]!).pathname.replace(/^\/blog\//, '');
    if (!volume || volume < 50) continue; // demand floor
    const existing = byKeyword.get(keyword);
    if (existing) { existing.ourSlugs.push(slug); continue; }
    byKeyword.set(keyword, {
      keyword, volume, cpc, difficulty, source: 'existing-post', ourSlugs: [slug],
      gsc: { position: null, impressions: 0 }, serp: [], serpSignals: { authority: 0, weak: 0, jobBoards: false, directories: false }
    });
  }
  console.log(`Candidates from existing posts (volume ≥ 50): ${byKeyword.size}`);

  // ── GATHER 2: replacement IDEAS for the phantom corpus ────────────────────
  const b = getBrandKnowledge();
  const ideaSeeds = b.target_market.sweet_spot_problems
    .concat(['online booking system for small business', 'workflow automation for small business', 'custom crm for real estate agents', 'mvp development for non technical founder', 'ai assistant for small business', 'software for property management company', 'client intake automation', 'connect crm to scheduling software'])
    .slice(0, 20);
  try {
    const ideas = await (svc as any).dataForSeoKeywordsForKeywords(ideaSeeds) as Array<{ keyword: string; volume: number | null; cpc: number | null; difficulty: number | null }>;
    const good = ideas
      .filter((i) => (i.volume ?? 0) >= 50 && (i.difficulty ?? 100) <= 60)
      .sort((a, z2) => (z2.cpc ?? 0) - (a.cpc ?? 0))
      .slice(0, 60);
    for (const i of good) {
      const k = i.keyword.toLowerCase();
      if (byKeyword.has(k)) continue;
      byKeyword.set(k, {
        keyword: k, volume: i.volume, cpc: i.cpc, difficulty: i.difficulty, source: 'idea', ourSlugs: [],
        gsc: { position: null, impressions: 0 }, serp: [], serpSignals: { authority: 0, weak: 0, jobBoards: false, directories: false }
      });
    }
    console.log(`+ replacement ideas (volume ≥ 50, difficulty ≤ 60, ranked by CPC): ${good.length}`);
  } catch (e) {
    console.log(`⚠️ ideas fetch failed (continuing with existing-post candidates): ${e instanceof Error ? e.message : String(e)}`);
  }

  const candidates = [...byKeyword.values()].slice(0, cap === Infinity ? undefined : cap);
  console.log(`Total candidates: ${candidates.length}`);

  return runValidation(candidates, gemini, svc, 'keyword-research-plan');
}

async function runValidation(
  candidates: Candidate[],
  gemini: InstanceType<typeof GeminiClient>,
  svc: InstanceType<typeof KeywordService>,
  outName: string
) {
  // ── GATHER 3: our GSC standing + live SERP per candidate (parallel, capped) ──
  let serpDone = 0;
  await mapConcurrent(candidates, 8, async (c) => {
    const [gsc] = await mysqlPool.query<RowDataPacket[]>(
      `SELECT AVG(position) AS pos, SUM(impressions) AS impr FROM gsc_performance
       WHERE query = ? AND date >= CURDATE() - INTERVAL 90 DAY`, [c.keyword]
    );
    const g = (gsc as any[])[0];
    c.gsc = { position: g?.pos != null ? Number(Number(g.pos).toFixed(1)) : null, impressions: Number(g?.impr ?? 0) };

    try {
      c.serp = await svc.dataForSeoSerpTop(c.keyword);
      c.serpSignals = serpSignals(c.serp);
    } catch (e) {
      console.log(`⚠️ SERP failed for "${c.keyword}": ${e instanceof Error ? e.message : String(e)}`);
    }
    serpDone++;
    if (serpDone % 20 === 0) console.log(`  SERP snapshots: ${serpDone}/${candidates.length}`);
  });

  // ── REASON: DeepSeek judges each keyword against the purpose ──────────────
  const b = getBrandKnowledge();
  const caseStudies = JSON.parse(fs.readFileSync(path.resolve('data/case_studies.json'), 'utf8'));
  const proofList = caseStudies.case_studies.map((cs: any) => `${cs.id}: ${cs.title} (${cs.business_type})`).join('\n');

  const systemPrompt = `You are the SEO research judge for Abdul's content system.

THE PURPOSE (judge everything against this): Abdul wins when a GROWING-BUSINESS BUYER
(owner of a service business, non-technical founder, or ops lead — $20k-$50k engagements,
decides directly) types a pain point or service into Google, lands on Abdul's page, and
reaches out. Traffic without buyers is worthless. Definitions-seekers, students, job
seekers, and enterprise procurement are NOT buyers.

TARGET MARKET: ${b.target_market.who_we_serve}
NOT our buyer: ${b.target_market.who_we_do_not_target}

REAL PROOF AVAILABLE (a keyword converts only if we can credibly serve it):
${proofList}

For each keyword you receive: evidence includes real search volume, CPC (the market's
price on buyer intent — high CPC means clicks convert to real contracts), Ads difficulty,
the LIVE top-10 SERP (domains + titles), pre-computed SERP signals (authority-site count,
weak-content count, job boards present = job-seeker intent, directories present =
comparison-shopping intent), our current GSC position/impressions, and our existing posts
targeting it (more than one = cannibalization to resolve).

VERDICTS:
- "priority": buyer-intent query we can realistically rank for AND credibly serve. The writing queue.
- "secondary": worth having but not first (lower lead value, harder SERP, or thinner proof).
- "reject": wrong intent (job seekers, students, enterprise), unwinnable SERP (authority-locked), or no proof fit.

For every keyword also give: lead_value (would this searcher pay $20k+?), icp_fit (which
persona or "none"), buyer_journey_stage, a one-sentence reason, a content_angle (the brand
take: friction-first, calm advisor, evidence over promises), and canonical_slug (if our
existing posts target it, pick the ONE slug to keep as canonical; else null).

Return STRICT JSON: {"verdicts": [...]} — no commentary, no markdown fences.`;

  const batchSize = 12;
  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));

  let judgedCount = 0;
  const batchResults = await mapConcurrent(batches, 6, async (batch, bi) => {
    const payload = batch.map((c) => ({
      keyword: c.keyword,
      volume: c.volume, cpc: c.cpc, ads_difficulty: c.difficulty, source: c.source,
      our_posts: c.ourSlugs, gsc_position: c.gsc.position, gsc_impressions: c.gsc.impressions,
      serp_top10: c.serp.map((s) => `${s.position}. ${s.domain} — ${s.title.slice(0, 70)}`),
      serp_signals: c.serpSignals
    }));
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await gemini.generateText({
          systemInstruction: systemPrompt,
          userPrompt: `KEYWORD EVIDENCE (${batch.length} keywords):\n${JSON.stringify(payload, null, 1)}\n\nReturn a verdict for EVERY keyword above.`,
          temperature: 0.3,
          maxOutputTokens: 8192
        });
        const parsed = verdictSchema.parse(safeJsonParse(raw));
        judgedCount += batch.length;
        console.log(`  judged: ${judgedCount}/${candidates.length}`);
        return parsed.verdicts.map((v): Verdict => ({
          keyword: v.keyword,
          verdict: v.verdict,
          lead_value: v.lead_value ?? 'low',
          icp_fit: v.icp_fit ?? 'none',
          buyer_journey_stage: v.buyer_journey_stage ?? 'awareness',
          reason: v.reason ?? 'no reason given',
          content_angle: v.content_angle ?? '',
          canonical_slug: v.canonical_slug ?? null
        }));
      } catch (e) {
        if (attempt === 2) console.log(`⚠️ batch ${bi + 1} failed twice: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
    return [];
  });
  const verdicts: Verdict[] = batchResults.flat();

  // ── OUTPUT ────────────────────────────────────────────────────────────────
  const byVerdict = (v: string) => verdicts.filter((x) => x.verdict === v);
  const candMap = new Map(candidates.map((c) => [c.keyword, c]));
  const outDir = path.resolve('review');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${outName}-verdicts.json`), JSON.stringify({ generated_for: 'wave-1 rewrite + phantom remap', verdicts, evidence: candidates }, null, 2));

  const md: string[] = [];
  md.push(`# Keyword Research Plan — agent v1\n`);
  md.push(`Purpose: every keyword below is judged on ONE question — will a $20k-$50k buyer find and hire Abdul through it?\n`);
  md.push(`Candidates: ${candidates.length} (${candidates.filter((c) => c.source === 'existing-post').length} from existing posts, ${candidates.filter((c) => c.source === 'idea').length} new ideas) | PRIORITY: ${byVerdict('priority').length} | SECONDARY: ${byVerdict('secondary').length} | REJECT: ${byVerdict('reject').length}\n`);
  for (const section of ['priority', 'secondary', 'reject'] as const) {
    md.push(`\n## ${section.toUpperCase()} (${byVerdict(section).length})\n`);
    md.push(`| Keyword | Vol | CPC | Lead value | ICP | Stage | Canonical post | Why / Angle |\n|---|---|---|---|---|---|---|---|`);
    for (const v of byVerdict(section).sort((a, z2) => (candMap.get(z2.keyword)?.cpc ?? 0) - (candMap.get(a.keyword)?.cpc ?? 0))) {
      const c = candMap.get(v.keyword);
      md.push(`| ${v.keyword} | ${c?.volume ?? '?'} | $${c?.cpc ?? '?'} | ${v.lead_value} | ${v.icp_fit} | ${v.buyer_journey_stage} | ${v.canonical_slug ?? '—'} | ${v.reason}${section !== 'reject' ? ` → ${v.content_angle}` : ''} |`);
    }
  }
  fs.writeFileSync(path.join(outDir, `${outName}.md`), md.join('\n'));

  console.log(`\n══ RESEARCH AGENT SUMMARY ══`);
  console.log(`PRIORITY: ${byVerdict('priority').length} | SECONDARY: ${byVerdict('secondary').length} | REJECT: ${byVerdict('reject').length}`);
  console.log(`Written: review/${outName}.md`);
  await mysqlPool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
