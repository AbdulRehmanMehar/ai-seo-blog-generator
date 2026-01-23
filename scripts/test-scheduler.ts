/**
 * Test the scheduler without waiting for cron triggers
 * 
 * Usage:
 *   npx tsx scripts/test-scheduler.ts [task]
 * 
 * Tasks:
 *   stats    - Log database stats
 *   review   - Review draft posts
 *   rewrite  - Rewrite failed posts
 *   cleanup  - Cleanup old data
 *   delete   - Delete marked posts
 *   pipeline - Run full pipeline (same as npm run runOnce)
 *   all      - Run all tasks in sequence
 */

import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { env } from '../src/config/env.js';
import { PostReviewer } from '../src/services/postReviewer.js';
import { PostRewriter } from '../src/services/postRewriter.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { runPipelineOnce } from '../src/scheduler/orchestrator.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

const task = process.argv[2] || 'stats';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function logDatabaseStats() {
  log('📊 Running stats...');
  
  const [mysqlRows] = await mysqlPool.query<RowDataPacket[]>('SELECT COUNT(*) as count FROM posts');
  const postsCount = mysqlRows[0]?.count ?? 0;
  
  const pgResult = await postgresPool.query('SELECT COUNT(*) as count FROM embeddings');
  const embeddingsCount = pgResult.rows[0]?.count ?? 0;
  
  // Additional stats
  const [statusRows] = await mysqlPool.query<RowDataPacket[]>(`
    SELECT status, COUNT(*) as cnt FROM posts GROUP BY status
  `);
  
  const [websiteRows] = await mysqlPool.query<RowDataPacket[]>(`
    SELECT w.domain, COUNT(p.id) as cnt 
    FROM websites w 
    LEFT JOIN posts p ON p.website_id = w.id
    GROUP BY w.id, w.domain
  `);
  
  log(`Posts: ${postsCount} | Embeddings: ${embeddingsCount}`);
  log('By status: ' + (statusRows as any[]).map(r => `${r.status}: ${r.cnt}`).join(', '));
  log('By website: ' + (websiteRows as any[]).map(r => `${r.domain}: ${r.cnt}`).join(', '));
}

function createGeminiClient(): GeminiClient {
  const apiKeys = env.GEMINI_API_KEYS?.split(',').map(k => k.trim()).filter(Boolean) ?? [];
  if (apiKeys.length === 0 && env.GEMINI_API_KEY) {
    apiKeys.push(env.GEMINI_API_KEY);
  }
  if (apiKeys.length === 0) {
    throw new Error('No Gemini API keys configured');
  }
  
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  return new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
}

async function runPostReviews() {
  log('📝 Running post reviews...');
  
  const gemini = createGeminiClient();
  const reviewer = new PostReviewer({ pool: mysqlPool, gemini });
  
  const result = await reviewer.reviewDraftPosts();
  log(`Reviewed: ${result.reviewed} | Passed: ${result.passed} | Failed: ${result.failed}`);
}

async function runPostRewrites() {
  log('🔄 Running post rewrites...');
  
  const gemini = createGeminiClient();
  const rewriter = new PostRewriter({ pool: mysqlPool, gemini });
  
  const result = await rewriter.rewritePendingPosts();
  log(`Processed: ${result.processed} | Succeeded: ${result.succeeded} | Failed: ${result.failed}`);
}

async function cleanupOldData() {
  log('🧹 Running cleanup...');
  
  const results: Record<string, number> = {};
  
  // Delete minute-level LLM data older than 24 hours
  const [minuteResult] = await mysqlPool.query<ResultSetHeader>(
    `DELETE FROM llm_usage_minute WHERE minute_bucket < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
  );
  results['llm_minute'] = minuteResult.affectedRows;
  
  // Delete daily LLM data older than 30 days
  const [dailyResult] = await mysqlPool.query<ResultSetHeader>(
    `DELETE FROM llm_usage_daily WHERE day < DATE_SUB(CURDATE(), INTERVAL 30 DAY)`
  );
  results['llm_daily'] = dailyResult.affectedRows;
  
  // Delete rejected keywords older than 90 days
  const [keywordsResult] = await mysqlPool.query<ResultSetHeader>(
    `DELETE FROM keywords WHERE status = 'rejected' AND created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`
  );
  results['keywords_rejected'] = keywordsResult.affectedRows;
  
  const summary = Object.entries(results)
    .map(([key, count]) => `${key}: ${count}`)
    .join(' | ');
  log(`Cleaned: ${summary}`);
}

async function deleteMarkedPosts() {
  log('🗑️ Deleting marked posts...');
  
  const [postsToDelete] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, title FROM posts WHERE status = 'to_be_deleted'`
  );
  
  if (postsToDelete.length === 0) {
    log('No posts marked for deletion');
    return;
  }
  
  log(`Found ${postsToDelete.length} post(s) to delete`);
  for (const p of postsToDelete as any[]) {
    log(`  - ${p.title.slice(0, 50)}...`);
  }
  
  // Note: Not actually deleting here for safety. Run the real scheduler task for that.
  log('⚠️  DRY RUN - Posts not actually deleted. Use the scheduler for real deletion.');
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SCHEDULER TEST - Task: ${task}`);
  console.log(`${'='.repeat(60)}\n`);
  
  try {
    switch (task) {
      case 'stats':
        await logDatabaseStats();
        break;
      case 'review':
        await runPostReviews();
        break;
      case 'rewrite':
        await runPostRewrites();
        break;
      case 'cleanup':
        await cleanupOldData();
        break;
      case 'delete':
        await deleteMarkedPosts();
        break;
      case 'pipeline':
        await runPipelineOnce();
        break;
      case 'all':
        await logDatabaseStats();
        await runPostReviews();
        await runPostRewrites();
        await cleanupOldData();
        await deleteMarkedPosts();
        break;
      default:
        console.log('Unknown task. Available: stats, review, rewrite, cleanup, delete, pipeline, all');
    }
  } finally {
    await mysqlPool.end();
    await postgresPool.end();
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('DONE');
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(console.error);
