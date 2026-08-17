/**
 * GENERATE ONE TARGETED POST — for a specific keyword the research agent
 * approved, without waiting for the scheduled pipeline to pick it up.
 * Runs the same path as the orchestrator: topic → draft → humanize → review
 * (with rewrite-on-fail), so every brand/evidence/NDA gate applies.
 *
 *   npx tsx scripts/generate-single-post.ts <domain> "<keyword>" "<topic angle>" [buyer_journey_stage]
 */
import '../src/config/forceIpv4.js'; // side-effect: patches dns.lookup to family:4 — must precede any network call
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import crypto from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { loadAuthorKnowledge } from '../src/knowledge/authorKnowledge.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { EmbeddingStore } from '../src/embeddings/embeddingStore.js';
import { BlogGenerator } from '../src/services/blogGenerator.js';
import { Humanizer } from '../src/services/humanizer.js';
import { PostReviewer } from '../src/services/postReviewer.js';
import { PostRewriter } from '../src/services/postRewriter.js';
import { WebsiteService } from '../src/services/websiteService.js';

async function main() {
  const [domain, keyword, angle, stage] = process.argv.slice(2);
  if (!domain || !keyword || !angle) {
    console.log('Usage: npx tsx scripts/generate-single-post.ts <domain> "<keyword>" "<topic angle>" [stage]');
    process.exit(1);
  }

  const websiteService = new WebsiteService(mysqlPool);
  const website = await websiteService.getByDomain(domain);
  if (!website) throw new Error(`website not found: ${domain}`);

  // Cannibalization pre-check (same rule as the generator guard, fail early & loud)
  const [dupes] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT slug FROM posts WHERE LOWER(TRIM(primary_keyword)) = LOWER(TRIM(?)) AND status IN ('published','draft','pending_review') AND website_id = ?`,
    [keyword, website.id]
  );
  if ((dupes as any[]).length > 0) {
    throw new Error(`cannibalization: "${keyword}" already targeted by /${(dupes as any[])[0].slug}`);
  }

  // Upsert keyword row
  const [kwRows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id FROM keywords WHERE LOWER(keyword) = LOWER(?)`, [keyword]
  );
  let keywordId = (kwRows as any[])[0]?.id as string | undefined;
  if (!keywordId) {
    keywordId = crypto.randomUUID();
    await mysqlPool.query(
      `INSERT INTO keywords(id, keyword, volume, difficulty, cpc, intent, status) VALUES (?, ?, NULL, NULL, NULL, 'commercial', 'used')`,
      [keywordId, keyword]
    );
  } else {
    await mysqlPool.query(`UPDATE keywords SET status = 'used' WHERE id = ?`, [keywordId]);
  }

  // Insert topic with a standard 6-step outline shaped by the agent's angle
  const topicId = crypto.randomUUID();
  const outline = {
    buyer_journey_stage: stage || 'consideration',
    sections: [
      { heading: 'Hook the exact daily friction this reader recognizes', level: 2, notes: `Angle: ${angle}` },
      { heading: 'Problem breakdown what is actually happening and who feels it', level: 2, notes: 'Operational consequences, no invented numbers' },
      { heading: 'Why the usual fixes fail', level: 2, notes: 'Off-the-shelf limits, workaround debt, contrarian take' },
      { heading: 'The better approach', level: 2, notes: 'Practical, phased, evidence from the real case studies only' },
      { heading: 'What working with me looks like', level: 2, notes: 'Process, timeline, direct access, first small step' },
      { heading: 'Actionable next steps', level: 2, notes: 'Concrete self-serve steps plus one low-friction diagnostic CTA' },
    ],
  };
  await mysqlPool.query(
    `INSERT INTO topics(id, keyword_id, topic, outline_json, website_id, target_icp) VALUES (?, ?, ?, ?, ?, ?)`,
    [topicId, keywordId, angle, JSON.stringify(outline), website.id, null]
  );
  console.log(`topic created: ${topicId}`);

  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  const gemini = new GeminiClient({
    rateLimiter: new GeminiRateLimiter(mysqlPool, apiKeys),
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_PROVIDER === 'openrouter' ? 0 : env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
  const knowledge = await loadAuthorKnowledge();
  const deps = { pool: mysqlPool, gemini };
  const embeddings = new EmbeddingStore(postgresPool);
  const generator = new BlogGenerator({ pool: mysqlPool, gemini, knowledge, embeddings, minWords: env.POST_MIN_WORDS });
  const humanizer = new Humanizer({ pool: mysqlPool, gemini, knowledge, minWords: env.POST_MIN_WORDS });
  const reviewer = new PostReviewer(deps);
  const rewriter = new PostRewriter(deps);

  console.log('generating draft...');
  const postId = await generator.generateDraftPost(topicId, website.id);
  console.log(`draft: ${postId}`);
  console.log('humanizing...');
  await humanizer.humanizePost(postId);
  console.log('reviewing...');
  let review = await reviewer.reviewPost(postId);
  console.log(`review: score=${review.score} passed=${review.passed}`);
  for (let attempt = 1; !review.passed && attempt <= 2; attempt++) {
    console.log(`rewrite attempt ${attempt}...`);
    await rewriter.rewritePost(postId, review, attempt);
    review = await reviewer.reviewPost(postId);
    console.log(`review after rewrite ${attempt}: score=${review.score} passed=${review.passed}`);
  }
  if (!review.passed) throw new Error('post failed review twice — left in draft for inspection');

  await mysqlPool.query(`UPDATE posts SET status = 'published' WHERE id = ?`, [postId]);
  const [[post]] = await mysqlPool.query<RowDataPacket[]>(`SELECT title, slug FROM posts WHERE id = ?`, [postId]) as any;
  console.log(`PUBLISHED: "${post.title}" → https://${domain}/blog/${post.slug}`);
  await mysqlPool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
