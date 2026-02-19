import type { RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env.js';
import { mysqlPool } from '../db/mysqlPool.js';
import { postgresPool } from '../db/postgresPool.js';
import { loadAuthorKnowledge } from '../knowledge/authorKnowledge.js';
import { GeminiClient } from '../llm/geminiClient.js';
import { GeminiRateLimiter } from '../llm/rateLimiter.js';
import { parseGeminiApiKeys } from '../llm/keyManager.js';
import { EmbeddingStore } from '../embeddings/embeddingStore.js';
import { KeywordService } from '../services/keywordService.js';
import { TopicPlanner } from '../services/topicPlanner.js';
import { DuplicateChecker } from '../services/duplicateChecker.js';
import { BlogGenerator } from '../services/blogGenerator.js';
import { Humanizer } from '../services/humanizer.js';
import { PostReviewer } from '../services/postReviewer.js';

function log(message: string) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${message}`);
}

function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export async function runPipelineOnce() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('🚀 PIPELINE RUN STARTED');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Parse API keys from env (supports both single and multiple keys)
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  if (apiKeys.length === 0) {
    throw new Error('Missing GEMINI_API_KEY or GEMINI_API_KEYS: required to run the pipeline.');
  }

  log('📚 Loading author knowledge...');
  const knowledge = await loadAuthorKnowledge();
  log(`   ✓ Author knowledge loaded (${knowledge.raw.length} chars)`);

  log('🔧 Initializing services...');
  log('   → Creating rate limiter...');

  // Initialize the comprehensive rate limiter
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  log('   ✓ Rate limiter created');

  log('   → Creating Gemini client...');

  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS
  });

  log(`   ✓ Gemini client (${apiKeys.length} key(s), model: ${env.GEMINI_GENERATION_MODEL})`);
  log(`   ✓ Rate limits: RPM/TPM/RPD tracking enabled (auto-switches keys)`);

  // Show current usage per key
  const usageSummary = await gemini.getUsageSummary();
  log(`   ✓ Key usage today: ${usageSummary}`);

  const embeddings = new EmbeddingStore(postgresPool);
  log('   ✓ Embedding store (Postgres + pgvector)');

  const keywordService = new KeywordService({ pool: mysqlPool, gemini });
  const topicPlanner = new TopicPlanner({ pool: mysqlPool, gemini, knowledge, embeddings });
  const duplicateChecker = new DuplicateChecker({ pool: mysqlPool, gemini, embeddings, threshold: env.DUPLICATE_SIMILARITY_THRESHOLD });
  const blogGenerator = new BlogGenerator({ pool: mysqlPool, gemini, knowledge, embeddings, minWords: env.POST_MIN_WORDS });
  const humanizer = new Humanizer({ pool: mysqlPool, gemini, knowledge, minWords: env.POST_MIN_WORDS });
  const postReviewer = new PostReviewer({ pool: mysqlPool, gemini });
  log('   ✓ All services initialized');

  log('');
  log('──────────────────────────────────────────────────────────────────────────');
  log('STEP 1: KEYWORD DISCOVERY');
  log('──────────────────────────────────────────────────────────────────────────');
  log('🔍 Discovering keywords via SERP providers + Gemini enrichment...');
  const keywordResult = await keywordService.discoverAndStoreKeywords();
  log(`   ✓ Keywords: discovered=${keywordResult.discovered}, new=${keywordResult.inserted}, filtered=${keywordResult.filtered}`);

  log('');
  log('──────────────────────────────────────────────────────────────────────────');
  log('STEP 2: TOPIC PLANNING & CONTENT GENERATION');
  log('──────────────────────────────────────────────────────────────────────────');

  const targetPosts = env.POSTS_PER_RUN;
  let created = 0;
  let duplicatesSkipped = 0;
  let attempts = 0;

  log(`🎯 Target: generate ${targetPosts} blog post(s)`);

  while (created < targetPosts && attempts < 3) {
    attempts += 1;
    const needed = Math.min(2, targetPosts - created);

    log('');
    log(`📋 Planning topics (attempt ${attempts}/3, need ${needed} more post(s))...`);
    const planned = await topicPlanner.planTopics({ candidateCount: 30, selectCount: needed });
    log(`   ✓ Topics planned: ${planned.length}`);

    if (planned.length === 0) {
      log('   ⚠️  No topics planned (no suitable keywords available)');
      break;
    }

    for (let i = 0; i < planned.length; i++) {
      const topicId = planned[i]!;
      if (created >= targetPosts) break;

      log('');
      log(`📝 Processing topic ${i + 1}/${planned.length} (id: ${topicId.slice(0, 8)}...)`);

      log('   🔎 Checking for duplicates...');
      const topicIsDup = await duplicateChecker.isDuplicateTopic(topicId);
      if (topicIsDup) {
        log('   ⏭️  Skipped: duplicate content detected');
        duplicatesSkipped += 1;
        continue;
      }
      log('   ✓ No duplicate found');

      log('   ✍️  Generating blog post draft...');
      const genStart = Date.now();
      const postId = await blogGenerator.generateDraftPost(topicId);
      const [[postTitleRow]] = await mysqlPool.query<RowDataPacket[]>('SELECT title FROM posts WHERE id = ?', [postId]);
      const postTitle = (postTitleRow as any)?.title ?? `id:${postId.slice(0, 8)}`;
      log(`   ✓ Draft created: "${postTitle}" (${elapsed(genStart)})`);

      log('   🧹 Humanizing content...');
      const humanStart = Date.now();
      await humanizer.humanizePost(postId);
      log(`   ✓ Humanization complete (${elapsed(humanStart)})`);

      log('   📋 Running quality review...');
      const reviewStart = Date.now();
      const reviewResult = await postReviewer.reviewPost(postId);
      const reviewTime = elapsed(reviewStart);
      if (reviewResult.passed) {
        log(`   ✓ Review PASSED (score: ${reviewResult.score}/100) → published (${reviewTime})`);
      } else {
        const topIssues = reviewResult.issues.slice(0, 3).map(i => i.code).join(', ');
        const extras = reviewResult.issues.length > 3 ? ` +${reviewResult.issues.length - 3} more` : '';
        log(`   ⚠️  Review FAILED (score: ${reviewResult.score}/100) → queued for rewrite (${reviewTime})`);
        log(`      Failing checks: ${topIssues}${extras}`);
      }

      created += 1;
      log(`   🎉 Post ${created}/${targetPosts} processed!`);
    }
  }

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('✅ PIPELINE RUN FINISHED');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`   Posts created:      ${created}/${targetPosts}`);
  log(`   Duplicates skipped: ${duplicatesSkipped}`);
  log(`   Planning attempts:  ${attempts}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
