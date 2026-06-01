/**
 * Test script: runs the content refresh pipeline on a single queued post
 * and prints a before/after comparison so you can judge content quality.
 *
 * Usage:
 *   npm run testRefresh [slug]
 *
 * If no slug is provided, uses the first queued item.
 */
import 'dotenv/config';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { ContentRefreshService } from '../src/services/contentRefreshService.js';
import { env } from '../src/config/env.js';
import type { BlogPostStructure } from '../src/prompts/blogGeneration.js';

function wordCount(cj: BlogPostStructure): number {
  return [
    cj.hero?.hook ?? '',
    cj.hero?.subtitle ?? '',
    ...(cj.sections ?? []).map(s => s.content ?? ''),
    ...(cj.faq ?? []).map(f => (f.question ?? '') + ' ' + (f.answer ?? '')),
    cj.conclusion?.summary ?? '',
    cj.conclusion?.cta?.text ?? '',
  ]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function printPost(label: string, cj: BlogPostStructure) {
  const wc = wordCount(cj);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${label}  [${wc} words]`);
  console.log('═'.repeat(70));
  console.log(`Title   : ${cj.title}`);
  console.log(`Slug    : ${cj.slug}`);
  console.log(`\nHero hook:\n  ${cj.hero?.hook ?? ''}`);
  console.log(`\nSections (${cj.sections?.length ?? 0}):`);
  for (const s of cj.sections ?? []) {
    const sw = (s.content ?? '').split(/\s+/).filter(Boolean).length;
    const flag = sw < 200 ? ' ⚠ THIN' : ' ✓';
    console.log(`  [${sw}w${flag}] ${s.heading}`);
    console.log(`    ${(s.content ?? '').slice(0, 120).replace(/\n/g, ' ')}...`);
  }
  console.log(`\nFAQ items: ${cj.faq?.length ?? 0}`);
  console.log(`Conclusion CTA: ${cj.conclusion?.cta?.text?.slice(0, 80) ?? ''}...`);
}

async function main() {
  const targetSlug = process.argv[2] ?? null;

  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  if (apiKeys.length === 0) throw new Error('No Gemini API keys configured');

  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });

  const refresher = new ContentRefreshService(mysqlPool, gemini);

  // Find target post
  let postId: string;
  let slug: string;
  if (targetSlug) {
    const [rows] = await mysqlPool.query<any[]>(
      `SELECT q.id as qid, p.id, p.slug FROM content_refresh_queue q
       JOIN posts p ON p.id = q.post_id
       WHERE p.slug = ? AND q.status = 'queued' LIMIT 1`,
      [targetSlug]
    );
    if (!rows.length) throw new Error(`No queued entry found for slug: ${targetSlug}`);
    postId = rows[0].id;
    slug = rows[0].slug;
  } else {
    const [rows] = await mysqlPool.query<any[]>(
      `SELECT q.id as qid, p.id, p.slug FROM content_refresh_queue q
       JOIN posts p ON p.id = q.post_id
       WHERE q.status = 'queued' AND q.attempts < 3
       ORDER BY q.queued_at ASC LIMIT 1`
    );
    if (!rows.length) throw new Error('Refresh queue is empty');
    postId = rows[0].id;
    slug = rows[0].slug;
  }

  console.log(`\nTesting refresh on: ${slug} (id: ${postId})`);

  // Capture BEFORE state
  const [beforeRows] = await mysqlPool.query<any[]>(
    'SELECT content_json FROM posts WHERE id = ?', [postId]
  );
  const beforeCj: BlogPostStructure =
    typeof beforeRows[0].content_json === 'string'
      ? JSON.parse(beforeRows[0].content_json)
      : beforeRows[0].content_json;

  printPost('BEFORE', beforeCj);

  console.log('\n\nRunning full_refresh... (this takes ~30-60 seconds)\n');
  const start = Date.now();
  const result = await refresher.processRefreshQueue(1);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\nRefresh complete in ${elapsed}s — processed=${result.processed} ok=${result.succeeded} failed=${result.failed}`);

  // Capture AFTER state
  const [afterRows] = await mysqlPool.query<any[]>(
    'SELECT content_json FROM posts WHERE id = ?', [postId]
  );
  const afterCj: BlogPostStructure =
    typeof afterRows[0].content_json === 'string'
      ? JSON.parse(afterRows[0].content_json)
      : afterRows[0].content_json;

  printPost('AFTER', afterCj);

  const before = wordCount(beforeCj);
  const after = wordCount(afterCj);
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Word count: ${before}w → ${after}w  (+${after - before}w, ${Math.round((after / before - 1) * 100)}% increase)`);
  const thinBefore = (beforeCj.sections ?? []).filter(s => (s.content ?? '').split(/\s+/).filter(Boolean).length < 200).length;
  const thinAfter  = (afterCj.sections  ?? []).filter(s => (s.content ?? '').split(/\s+/).filter(Boolean).length < 200).length;
  console.log(`Thin sections (< 200w): ${thinBefore} → ${thinAfter}`);
  console.log(`Google indexing threshold (1800w): ${after >= 1800 ? '✓ PASSES' : `✗ FAILS (need ${1800 - after} more words)`}`);
  console.log('─'.repeat(70));

  await mysqlPool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
