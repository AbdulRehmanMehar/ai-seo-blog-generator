import cron from 'node-cron';
import { env } from '../config/env.js';
import { runPipelineOnce } from './orchestrator.js';
import { syncGitHubKnowledge } from '../knowledge/knowledgeSync.js';
import { mysqlPool } from '../db/mysqlPool.js';
import { postgresPool } from '../db/postgresPool.js';
import { PostReviewer } from '../services/postReviewer.js';
import { PostRewriter } from '../services/postRewriter.js';
import { GeminiRateLimiter } from '../llm/rateLimiter.js';
import { GeminiClient } from '../llm/geminiClient.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

/**
 * Query and log database stats (posts count from MySQL, embeddings count from PostgreSQL)
 */
async function logDatabaseStats() {
  const timestamp = new Date().toISOString();
  
  try {
    // MySQL: posts count
    const [mysqlRows] = await mysqlPool.query<RowDataPacket[]>(
      'SELECT COUNT(*) as count FROM posts'
    );
    const postsCount = mysqlRows[0]?.count ?? 0;
    
    // PostgreSQL: embeddings count
    const pgResult = await postgresPool.query(
      'SELECT COUNT(*) as count FROM embeddings'
    );
    const embeddingsCount = pgResult.rows[0]?.count ?? 0;
    
    // eslint-disable-next-line no-console
    console.log(`[${timestamp}] 📊 Stats | Posts: ${postsCount} | Embeddings: ${embeddingsCount}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${timestamp}] Stats query failed:`, err);
  }
}

/**
 * Cleanup old usage tracking data to save database space
 * 
 * MySQL tables cleaned:
 * - llm_usage_minute: 24 hours (only need current day for RPM/TPM rate limiting)
 * - llm_usage_daily: 30 days (keep some history for analysis)
 * - serp_usage_monthly: 12 months (keep a year of SERP usage history)
 * - keywords (rejected): 90 days (old rejected keywords are useless)
 * - topics (orphaned): 30 days (topics with no posts that were never used)
 * 
 * PostgreSQL tables cleaned:
 * - embeddings (orphaned): Remove embeddings for deleted topics/posts
 */
async function cleanupOldUsageData() {
  const timestamp = new Date().toISOString();
  const results: Record<string, number> = {};
  
  try {
    // MySQL Cleanup
    
    // 1. Delete minute-level LLM data older than 24 hours
    const [minuteResult] = await mysqlPool.query<ResultSetHeader>(
      `DELETE FROM llm_usage_minute WHERE minute_bucket < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );
    results['llm_minute'] = minuteResult.affectedRows;
    
    // 2. Delete daily LLM data older than 30 days
    const [dailyResult] = await mysqlPool.query<ResultSetHeader>(
      `DELETE FROM llm_usage_daily WHERE day < DATE_SUB(CURDATE(), INTERVAL 30 DAY)`
    );
    results['llm_daily'] = dailyResult.affectedRows;
    
    // 3. Delete SERP usage older than 12 months
    const [serpResult] = await mysqlPool.query<ResultSetHeader>(
      `DELETE FROM serp_usage_monthly WHERE month_year < DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 12 MONTH), '%Y-%m')`
    );
    results['serp_monthly'] = serpResult.affectedRows;
    
    // 4. Delete rejected keywords older than 90 days
    const [keywordsResult] = await mysqlPool.query<ResultSetHeader>(
      `DELETE FROM keywords WHERE status = 'rejected' AND created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`
    );
    results['keywords_rejected'] = keywordsResult.affectedRows;
    
    // 5. Delete orphaned topics (no posts) older than 30 days
    const [topicsResult] = await mysqlPool.query<ResultSetHeader>(
      `DELETE t FROM topics t 
       LEFT JOIN posts p ON p.topic_id = t.id 
       WHERE p.id IS NULL AND t.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );
    results['topics_orphaned'] = topicsResult.affectedRows;
    
    // PostgreSQL Cleanup - Delete orphaned embeddings
    
    // 6. Get valid IDs from MySQL
    const validTopicIds = await getValidTopicIds();
    const validPostIds = await getValidPostIds();
    
    // 7. Delete orphaned topic embeddings
    let topicEmbedDeleted = 0;
    if (validTopicIds.length > 0) {
      const topicResult = await postgresPool.query(
        `DELETE FROM embeddings WHERE entity_type = 'topic' AND entity_id != ALL($1)`,
        [validTopicIds]
      );
      topicEmbedDeleted = topicResult.rowCount ?? 0;
    } else {
      // No topics exist, delete all topic embeddings
      const topicResult = await postgresPool.query(
        `DELETE FROM embeddings WHERE entity_type = 'topic'`
      );
      topicEmbedDeleted = topicResult.rowCount ?? 0;
    }
    results['embeddings_topics'] = topicEmbedDeleted;
    
    // 8. Delete orphaned post embeddings
    let postEmbedDeleted = 0;
    if (validPostIds.length > 0) {
      const postResult = await postgresPool.query(
        `DELETE FROM embeddings WHERE entity_type = 'post' AND entity_id != ALL($1)`,
        [validPostIds]
      );
      postEmbedDeleted = postResult.rowCount ?? 0;
    } else {
      // No posts exist, delete all post embeddings
      const postResult = await postgresPool.query(
        `DELETE FROM embeddings WHERE entity_type = 'post'`
      );
      postEmbedDeleted = postResult.rowCount ?? 0;
    }
    results['embeddings_posts'] = postEmbedDeleted;
    
    // Log if anything was cleaned
    const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0);
    if (totalDeleted > 0) {
      const summary = Object.entries(results)
        .filter(([, count]) => count > 0)
        .map(([key, count]) => `${key}: ${count}`)
        .join(' | ');
      // eslint-disable-next-line no-console
      console.log(`[${timestamp}] 🧹 Cleanup | ${summary}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${timestamp}] Cleanup failed:`, err);
  }
}

/** Helper: Get all valid topic IDs from MySQL */
async function getValidTopicIds(): Promise<string[]> {
  const [rows] = await mysqlPool.query<RowDataPacket[]>('SELECT id FROM topics');
  return rows.map(r => r.id);
}

/** Helper: Get all valid post IDs from MySQL */
async function getValidPostIds(): Promise<string[]> {
  const [rows] = await mysqlPool.query<RowDataPacket[]>('SELECT id FROM posts');
  return rows.map(r => r.id);
}

/**
 * Create shared Gemini client for scheduled tasks
 */
function createSchedulerGeminiClient(): GeminiClient {
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

/**
 * Review all draft posts
 */
async function runPostReviews(): Promise<void> {
  const timestamp = new Date().toISOString();
  
  try {
    const gemini = createSchedulerGeminiClient();
    const reviewer = new PostReviewer({ pool: mysqlPool, gemini });
    
    const result = await reviewer.reviewDraftPosts();
    
    if (result.reviewed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[${timestamp}] 📝 Review | Reviewed: ${result.reviewed} | Passed: ${result.passed} | Failed: ${result.failed}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${timestamp}] Post review failed:`, err);
  }
}

/**
 * Rewrite posts that failed review
 */
async function runPostRewrites(): Promise<void> {
  const timestamp = new Date().toISOString();
  
  try {
    const gemini = createSchedulerGeminiClient();
    const rewriter = new PostRewriter({ pool: mysqlPool, gemini });
    
    const result = await rewriter.rewritePendingPosts();
    
    if (result.processed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[${timestamp}] 🔄 Rewrite | Processed: ${result.processed} | Succeeded: ${result.succeeded} | Failed: ${result.failed}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${timestamp}] Post rewrite failed:`, err);
  }
}

/**
 * Delete posts marked for deletion and their associated data
 */
async function deleteMarkedPosts(): Promise<void> {
  const timestamp = new Date().toISOString();
  
  try {
    // Get posts to delete
    const [postsToDelete] = await mysqlPool.query<RowDataPacket[]>(
      `SELECT p.id as post_id, p.title, p.topic_id, t.keyword_id
       FROM posts p
       JOIN topics t ON t.id = p.topic_id
       WHERE p.status = 'to_be_deleted'`
    );
    
    if (postsToDelete.length === 0) return;
    
    for (const post of postsToDelete) {
      try {
        // 1. Delete post embedding from PostgreSQL
        await postgresPool.query(
          `DELETE FROM embeddings WHERE entity_type = 'post' AND entity_id = $1`,
          [post.post_id]
        );
        
        // 2. Delete topic embedding from PostgreSQL
        await postgresPool.query(
          `DELETE FROM embeddings WHERE entity_type = 'topic' AND entity_id = $1`,
          [post.topic_id]
        );
        
        // 3. Delete post reviews
        await mysqlPool.query<ResultSetHeader>(
          `DELETE FROM post_reviews WHERE post_id = ?`,
          [post.post_id]
        );
        
        // 4. Delete the post
        await mysqlPool.query<ResultSetHeader>(
          `DELETE FROM posts WHERE id = ?`,
          [post.post_id]
        );
        
        // 5. Delete the topic
        await mysqlPool.query<ResultSetHeader>(
          `DELETE FROM topics WHERE id = ?`,
          [post.topic_id]
        );
        
        // 6. Mark keyword as rejected
        await mysqlPool.query<ResultSetHeader>(
          `UPDATE keywords SET status = 'rejected' WHERE id = ?`,
          [post.keyword_id]
        );
        
        // eslint-disable-next-line no-console
        console.log(`[${timestamp}] 🗑️ Deleted post "${post.title}" and associated data`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[${timestamp}] Failed to delete post ${post.post_id}:`, err);
      }
    }
    
    // eslint-disable-next-line no-console
    console.log(`[${timestamp}] 🗑️ Delete | Processed: ${postsToDelete.length} posts marked for deletion`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${timestamp}] Delete marked posts failed:`, err);
  }
}

export function startScheduler() {
  // eslint-disable-next-line no-console
  console.log('Scheduler starting...');

  // Blog generation pipeline
  cron.schedule(env.CRON_SCHEDULE_1, async () => {
    await runPipelineOnce();
  });

  if (env.CRON_SCHEDULE_2) {
    cron.schedule(env.CRON_SCHEDULE_2, async () => {
      await runPipelineOnce();
    });
  }

  // Knowledge base sync (GitHub repos)
  if (env.GITHUB_PAT) {
    cron.schedule(env.CRON_KNOWLEDGE_SYNC, async () => {
      try {
        await syncGitHubKnowledge();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Knowledge sync failed:', err);
      }
    });
    // eslint-disable-next-line no-console
    console.log('Knowledge sync scheduled:', env.CRON_KNOWLEDGE_SYNC);
  }

  // Database stats - every hour
  cron.schedule('0 * * * *', async () => {
    await logDatabaseStats();
  });
  // eslint-disable-next-line no-console
  console.log('Database stats scheduled: every hour (0 * * * *)');

  // Cleanup old usage data - daily at 3 AM
  cron.schedule('0 3 * * *', async () => {
    await cleanupOldUsageData();
  });
  // eslint-disable-next-line no-console
  console.log('Usage data cleanup scheduled: daily at 3 AM (0 3 * * *)');

  // Post review - every 2 hours (review draft posts)
  cron.schedule('0 */2 * * *', async () => {
    await runPostReviews();
  });
  // eslint-disable-next-line no-console
  console.log('Post review scheduled: every 2 hours (0 */2 * * *)');

  // Post rewrite - every 3 hours (rewrite failed posts)
  cron.schedule('0 */3 * * *', async () => {
    await runPostRewrites();
  });
  // eslint-disable-next-line no-console
  console.log('Post rewrite scheduled: every 3 hours (0 */3 * * *)');

  // Delete marked posts - daily at 4 AM (after cleanup)
  cron.schedule('0 4 * * *', async () => {
    await deleteMarkedPosts();
  });
  // eslint-disable-next-line no-console
  console.log('Post deletion scheduled: daily at 4 AM (0 4 * * *)');

  // Log stats immediately on startup
  logDatabaseStats();

  // eslint-disable-next-line no-console
  console.log('Pipeline schedules:', env.CRON_SCHEDULE_1, env.CRON_SCHEDULE_2 ?? '(none)');
}
