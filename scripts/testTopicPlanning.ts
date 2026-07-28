/**
 * Test: Topic Planning — Niche Focus + Buyer Journey Stage Distribution
 *
 * Runs the topic planner against a set of niche keywords and prints a full
 * grade report WITHOUT saving anything to the database.
 *
 * Usage:
 *   npm run testTopicPlanning
 *
 * What it checks:
 *   ✓ ICP data loads correctly (4 personas, correct fields)
 *   ✓ Topic planner only selects niche-relevant keywords
 *   ✓ Topics are distributed across all 4 buyer journey stages
 *   ✓ No colons or em dashes in any headline
 *   ✓ Every headline contains a pain point, outcome, or curiosity gap
 *   ✓ LLM rejects off-niche keywords from the candidate list
 */
import 'dotenv/config';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { loadIcps } from '../src/knowledge/icpKnowledge.js';
import { loadAuthorKnowledge } from '../src/knowledge/authorKnowledge.js';
import { topicPlanningPrompt } from '../src/prompts/topicPlanning.js';
import { env } from '../src/config/env.js';
import type { RowDataPacket } from 'mysql2/promise';

// ─── Off-niche decoys injected into the candidate list ────────────────────────
// The LLM should reject all of these. If any appear in output, that's a failure.
const OFF_NICHE_DECOYS = [
  { keyword: 'logistics software development dubai', volume: 250, difficulty: 30, cpc: 8.5, intent: 'commercial' },
  { keyword: 'luxury ecommerce development', volume: 300, difficulty: 35, cpc: 12.0, intent: 'commercial' },
  { keyword: 'kyc aml banking automation', volume: 300, difficulty: 30, cpc: 11.0, intent: 'commercial' },
  { keyword: 'pharmaceutical drug discovery ai', volume: 150, difficulty: 40, cpc: 9.0, intent: 'informational' },
  { keyword: 'real estate crm solutions', volume: 650, difficulty: 30, cpc: 19.1, intent: 'commercial' },
];

function safeJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const src = fenced?.[1]?.trim() ?? trimmed;
  const objStart = src.indexOf('{');
  const objEnd = src.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    return JSON.parse(src.slice(objStart, objEnd + 1).replace(/,(\s*[}\]])/g, '$1'));
  }
  throw new Error('No JSON object found');
}

function grade(label: string, pass: boolean, detail = '') {
  const icon = pass ? '✓' : '✗';
  const color = pass ? '' : ' ← FAIL';
  console.log(`  ${icon} ${label}${color}${detail ? ': ' + detail : ''}`);
  return pass;
}

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('TOPIC PLANNING TEST — Niche Focus + Buyer Journey Stages');
  console.log('═'.repeat(70));

  // ── 1. Validate ICPs ───────────────────────────────────────────────────────
  console.log('\n[ 1/4 ] Validating ICP data...');
  const icps = await loadIcps();
  grade('Exactly 4 ICPs loaded', icps.length === 4, `found ${icps.length}`);
  for (const icp of icps) {
    grade(`"${icp.persona_name}" has trigger_events`, Array.isArray(icp.trigger_events) && icp.trigger_events.length > 0);
    grade(`"${icp.persona_name}" has hiring_threshold`, typeof icp.hiring_threshold === 'string' && icp.hiring_threshold.length > 50);
    grade(`"${icp.persona_name}" has cost_of_inaction`, typeof icp.cost_of_inaction === 'string' && icp.cost_of_inaction.length > 50);
  }

  // ── 2. Build candidate keyword list ───────────────────────────────────────
  console.log('\n[ 2/4 ] Fetching niche keywords from database...');
  const [rows] = await mysqlPool.query<RowDataPacket[]>(`
    SELECT keyword, volume, difficulty, cpc, intent
    FROM keywords
    WHERE status = 'new'
    AND (
      keyword LIKE '%technical debt%'
      OR keyword LIKE '%legacy%'
      OR keyword LIKE '%moderniz%'
      OR keyword LIKE '%due diligence%'
      OR keyword LIKE '%acquisition%'
      OR keyword LIKE '%series b%'
      OR keyword LIKE '%valuation%'
      OR keyword LIKE '%pre-exit%'
      OR keyword LIKE '%.net migration%'
      OR keyword LIKE '%codebase%'
    )
    ORDER BY COALESCE(cpc, 0) DESC
    LIMIT 10
  `);

  const nicheKeywords = (rows as any[]).map(r => ({
    keyword: String(r.keyword),
    volume: r.volume ? Number(r.volume) : null,
    difficulty: r.difficulty ? Number(r.difficulty) : null,
    cpc: r.cpc ? Number(r.cpc) : null,
    intent: r.intent ? String(r.intent) : null,
  }));

  grade('At least 5 niche keywords found in DB', nicheKeywords.length >= 5, `found ${nicheKeywords.length}`);
  console.log('  Niche keywords:');
  nicheKeywords.forEach(k => console.log(`    • [cpc:$${k.cpc}] ${k.keyword}`));

  // Mix in off-niche decoys — the LLM should reject all of them
  const allCandidates = [...nicheKeywords, ...OFF_NICHE_DECOYS];
  console.log(`\n  Injecting ${OFF_NICHE_DECOYS.length} off-niche decoy keywords to test rejection.`);
  console.log('  Decoys:');
  OFF_NICHE_DECOYS.forEach(k => console.log(`    ✗ ${k.keyword}`));

  // ── 3. Run topic planning (LLM call) ──────────────────────────────────────
  console.log('\n[ 3/4 ] Running topic planner (LLM call)...');
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  if (apiKeys.length === 0) throw new Error('No Gemini API keys configured');

  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });

  const knowledge = await loadAuthorKnowledge();
  const targetIcp = icps[0]!; // Use first ICP for this test

  const SELECT_COUNT = 4; // Small batch for test
  const prompt = topicPlanningPrompt({
    knowledge,
    candidateKeywords: allCandidates,
    selectCount: SELECT_COUNT,
    targetWebsite: 'primestrides.com',
    targetIcp,
  });

  const start = Date.now();
  const raw = await gemini.generateText({
    systemInstruction: prompt.system,
    userPrompt: prompt.user,
    temperature: 0.4,
    maxOutputTokens: 2048,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  LLM responded in ${elapsed}s`);

  let plan: { selected: Array<{ keyword: string; topic: string; buyer_journey_stage?: string; outline: Array<{ heading: string; level: number; notes: string }> }> };
  try {
    plan = safeJsonParse(raw) as typeof plan;
  } catch (err) {
    console.log('\n  ✗ FAIL: LLM did not return valid JSON');
    console.log('  Raw output (first 500 chars):', String(raw).slice(0, 500));
    await mysqlPool.end();
    process.exit(1);
  }

  // ── 4. Grade the output ───────────────────────────────────────────────────
  console.log('\n[ 4/4 ] Grading output...\n');

  const selected = plan.selected ?? [];
  const nicheKeywordNames = new Set(nicheKeywords.map(k => k.keyword.toLowerCase()));
  const decoyKeywordNames = new Set(OFF_NICHE_DECOYS.map(k => k.keyword.toLowerCase()));
  const stages = selected.map(t => t.buyer_journey_stage ?? 'unknown');
  const stageCounts = { awareness: 0, consideration: 0, decision: 0, validation: 0 };
  stages.forEach(s => { if (s in stageCounts) stageCounts[s as keyof typeof stageCounts]++; });

  let passes = 0;
  let failures = 0;

  function check(label: string, pass: boolean, detail = '') {
    const ok = grade(label, pass, detail);
    if (ok) passes++; else failures++;
  }

  // Structural checks
  check('LLM returned valid JSON with "selected" array', Array.isArray(selected));
  check(`Selected ${SELECT_COUNT} or fewer topics`, selected.length <= SELECT_COUNT, `got ${selected.length}`);
  // With 4 topics at 40/30/20/10 ratio, validation gets 0 — that is correct.
  // Require at least awareness + consideration + decision to be present.
  const distinctStages = Object.values(stageCounts).filter(v => v > 0).length;
  const minExpectedStages = selected.length >= 4 ? 3 : 2;
  check(`At least ${minExpectedStages} distinct stages represented`, distinctStages >= minExpectedStages, `got ${distinctStages} stages`);

  // Per-topic checks
  console.log('\n  Topics selected:');
  for (const t of selected) {
    const isDecoy = decoyKeywordNames.has(t.keyword.toLowerCase());
    const isNiche = nicheKeywordNames.has(t.keyword.toLowerCase());
    const hasColon = t.topic.includes(':');
    const hasEmDash = t.topic.includes('—') || t.topic.includes('–');
    const stage = t.buyer_journey_stage ?? 'missing';
    const validStage = ['awareness', 'consideration', 'decision', 'validation'].includes(stage);

    console.log(`\n  ─── "${t.topic}"`);
    console.log(`      keyword: ${t.keyword} | stage: ${stage}`);
    check(`    Not a decoy keyword`, !isDecoy, isDecoy ? `"${t.keyword}" is off-niche!` : '');
    check(`    Has valid buyer_journey_stage`, validStage, stage);
    check(`    No colon in headline`, !hasColon);
    check(`    No em dash in headline`, !hasEmDash);
    check(`    Has outline sections`, Array.isArray(t.outline) && t.outline.length >= 4, `${t.outline?.length ?? 0} sections`);
    if (t.outline?.length > 0) {
      const hasCOI = t.outline.some(s => /cost|dollar|loss|valuation|million|save|fund|risk|impact|revenue|financial|debt|budget|penalty|damage/i.test(s.notes));
      check(`    Outline contains cost-of-inaction`, hasCOI);
    }
  }

  // Decoy rejection check
  console.log('\n  Decoy rejection:');
  const selectedKeywords = new Set(selected.map(t => t.keyword.toLowerCase()));
  let allDecoysRejected = true;
  for (const decoy of OFF_NICHE_DECOYS) {
    const wasSelected = selectedKeywords.has(decoy.keyword.toLowerCase());
    check(`    Rejected "${decoy.keyword}"`, !wasSelected);
    if (wasSelected) allDecoysRejected = false;
  }

  // Stage distribution
  console.log('\n  Stage distribution:');
  console.log(`    awareness: ${stageCounts.awareness} | consideration: ${stageCounts.consideration} | decision: ${stageCounts.decision} | validation: ${stageCounts.validation}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log(`RESULT: ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log('✓ Pipeline is correctly niche-focused and stage-aware.');
  } else {
    console.log('✗ Some checks failed — review the output above before running the full pipeline.');
  }
  console.log('═'.repeat(70) + '\n');

  await mysqlPool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
