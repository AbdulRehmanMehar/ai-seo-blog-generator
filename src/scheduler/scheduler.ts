import cron from 'node-cron';
import { env } from '../config/env.js';
import { runPipelineOnce } from './orchestrator.js';
import { syncGitHubKnowledge } from '../knowledge/knowledgeSync.js';
import { mysqlPool } from '../db/mysqlPool.js';
import { postgresPool } from '../db/postgresPool.js';
import { pgKeepAlive } from '../db/keepAlive.js';
import { PostReviewer } from '../services/postReviewer.js';
import { PostRewriter } from '../services/postRewriter.js';
import { GeminiRateLimiter } from '../llm/rateLimiter.js';
import { GeminiClient } from '../llm/geminiClient.js';
import { GscSyncService } from '../services/gscSyncService.js';
import { GscOpportunityDetector } from '../services/gscOpportunityDetector.js';
import { ContentRefreshService } from '../services/contentRefreshService.js';
import { Ga4EngagementRefreshDetector } from '../services/ga4EngagementRefreshDetector.js';
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

    // GSC stats (best-effort — tables may not exist yet)
    let gscStats = '';
    try {
      const [gscRows] = await mysqlPool.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM gsc_performance) as perf_rows,
           (SELECT COUNT(*) FROM gsc_opportunities WHERE status = 'pending') as pending_opps,
           (SELECT COUNT(*) FROM content_refresh_queue WHERE status = 'queued') as refresh_queued`
      );
      const g = gscRows[0] as { perf_rows: number; pending_opps: number; refresh_queued: number } | undefined;
      if (g) {
        gscStats = ` | GSC rows: ${g.perf_rows} | Opps: ${g.pending_opps} | Refresh queue: ${g.refresh_queued}`;
      }
    } catch { /* GSC tables not migrated yet — skip */ }

    // eslint-disable-next-line no-console
    console.log(`[${timestamp}] 📊 Stats | Posts: ${postsCount} | Embeddings: ${embeddingsCount}${gscStats}`);
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
    
    // 4. Delete orphaned topics (no posts) older than 30 days — must run before keyword cleanup
    //    so that orphaned topics don't block the FK-constrained keyword delete below.
    const [topicsResult] = await mysqlPool.query<ResultSetHeader>(
      `DELETE t FROM topics t
       LEFT JOIN posts p ON p.topic_id = t.id
       WHERE p.id IS NULL AND t.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );
    results['topics_orphaned'] = topicsResult.affectedRows;

    // 5. Delete rejected keywords older than 90 days.
    //    Exclude any still referenced by a topic (e.g. topics that have posts and can't be deleted above).
    const [keywordsResult] = await mysqlPool.query<ResultSetHeader>(
      `DELETE FROM keywords
       WHERE status = 'rejected'
         AND created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)
         AND id NOT IN (SELECT keyword_id FROM topics WHERE keyword_id IS NOT NULL)`
    );
    results['keywords_rejected'] = keywordsResult.affectedRows;
    
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

/**
 * Pull the last 28 days of GSC performance data for all configured websites.
 * Runs at 6 AM, before the 9:15 AM content pipeline.
 */
async function runGscSync(): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    const syncer = new GscSyncService(mysqlPool);
    const results = await syncer.syncAll();
    for (const r of results) {
      if (r.error) {
        console.warn(`[${timestamp}] GSC Sync | ${r.siteDomain}: ${r.error}`);
      } else {
        console.log(
          `[${timestamp}] 📡 GSC Sync | ${r.siteDomain} | Perf rows: ${r.rowsUpserted} | Page metrics: ${r.pageMetricsUpserted}`
        );
      }
    }
  } catch (err) {
    console.error(`[${timestamp}] GSC sync failed:`, err);
  }
}

/**
 * Detect low-CTR pages, near-miss keywords, and declining content.
 * Writes to gsc_opportunities and inserts near-miss keywords into the keywords table.
 * Runs at 7 AM, after GSC sync.
 */
async function runOpportunityDetection(): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    const detector = new GscOpportunityDetector(mysqlPool);
    const results = await detector.detectAll();
    for (const r of results) {
      const total = r.lowCtr + r.nearMiss + r.declining;
      if (total > 0) {
        console.log(
          `[${timestamp}] 🔍 GSC Opportunities | website: ${r.websiteId} | low_ctr: ${r.lowCtr} | near_miss: ${r.nearMiss} | declining: ${r.declining}`
        );
      }
    }

    // Import near-miss keywords into the keywords table so the pipeline can pick them up
    const { KeywordService } = await import('../services/keywordService.js');
    const apiKeys = env.GEMINI_API_KEYS?.split(',').map(k => k.trim()).filter(Boolean) ?? [];
    if (apiKeys.length === 0 && env.GEMINI_API_KEY) apiKeys.push(env.GEMINI_API_KEY);
    if (apiKeys.length > 0) {
      const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
      const gemini = new GeminiClient({
        rateLimiter,
        generationModel: env.GEMINI_GENERATION_MODEL,
        embeddingModel: env.GEMINI_EMBEDDING_MODEL,
        minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
      });
      const kwService = new KeywordService({ pool: mysqlPool, gemini });
      const imported = await kwService.importNearMissKeywords();
      if (imported > 0) {
        console.log(`[${timestamp}] 📡 GSC Near-Miss | Imported ${imported} new keywords`);
      }
    }
  } catch (err) {
    console.error(`[${timestamp}] Opportunity detection failed:`, err);
  }
}

/**
 * GA4 engagement-based refresh detection.
 * Queues full_refresh for posts that get Organic traffic but have high bounce + low engagement.
 * Runs daily after GSC opportunity detection.
 */
async function runGa4EngagementDetection(): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    const detector = new Ga4EngagementRefreshDetector(mysqlPool);
    const results = await detector.detectAndQueueAll({
      daysBack: 90,
      maxPerWebsite: 3,
      minSessions: 20,
      minBounceRate: 0.75,
      maxAvgEngagementSec: 30,
    });

    for (const r of results) {
      if (r.skipped) {
        console.log(`[${timestamp}] GA4 Engagement | website: ${r.websiteId} | skipped: ${r.skipped}`);
      } else if (r.queued > 0) {
        console.log(`[${timestamp}] 📉 GA4 Engagement | website: ${r.websiteId} | queued refreshes: ${r.queued}`);
      }
    }
  } catch (err) {
    console.error(`[${timestamp}] GA4 engagement detection failed:`, err);
  }
}

/**
 * Process one post from the content_refresh_queue.
 * Runs every 6 hours — caps at 1 post per run to stay within LLM rate limits.
 */
async function runContentRefresh(): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    const gemini = createSchedulerGeminiClient();
    const refresher = new ContentRefreshService(mysqlPool, gemini);
    const result = await refresher.processRefreshQueue();
    if (result.processed > 0) {
      console.log(
        `[${timestamp}] 🔄 Content Refresh | Processed: ${result.processed} | OK: ${result.succeeded} | Failed: ${result.failed}`
      );
    }
  } catch (err) {
    console.error(`[${timestamp}] Content refresh failed:`, err);
  }
}

/**
 * Rewrite titles and meta descriptions for the top low-CTR pages.
 * Runs weekly on Monday — title changes need ~1 week to show CTR impact in GSC.
 */
async function runCtrOptimization(): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    const gemini = createSchedulerGeminiClient();
    const refresher = new ContentRefreshService(mysqlPool, gemini);
    const result = await refresher.runCtrOptimizations(3);
    if (result.optimized > 0) {
      console.log(
        `[${timestamp}] 📈 CTR Optimize | Optimized: ${result.optimized} | Failed: ${result.failed}`
      );
    }
  } catch (err) {
    console.error(`[${timestamp}] CTR optimization failed:`, err);
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

  // Postgres keep-alive - prevents the managed instance from being suspended for
  // inactivity (write + read a heartbeat row). Runs once now and on a schedule.
  const pgKeepAliveTick = async () => {
    const ts = new Date().toISOString();
    const r = await pgKeepAlive();
    // eslint-disable-next-line no-console
    if (r.ok) console.log(`[${ts}] 💓 Postgres keep-alive ok (last_ping=${r.lastPing})`);
    else console.error(`[${ts}] 💔 Postgres keep-alive failed: ${r.error}`);
  };
  void pgKeepAliveTick();
  cron.schedule(env.CRON_PG_KEEPALIVE, () => { void pgKeepAliveTick(); });
  // eslint-disable-next-line no-console
  console.log('Postgres keep-alive scheduled:', env.CRON_PG_KEEPALIVE);

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

  // ── GSC Integration ────────────────────────────────────────────────────────

  // GSC data sync - daily at 6 AM (before 9:15 AM pipeline)
  cron.schedule('0 6 * * *', async () => {
    await runGscSync();
  });
  // eslint-disable-next-line no-console
  console.log('GSC sync scheduled: daily at 6 AM (0 6 * * *)');

  // Opportunity detection - daily at 7 AM (after GSC sync)
  cron.schedule('0 7 * * *', async () => {
    await runOpportunityDetection();
  });
  // eslint-disable-next-line no-console
  console.log('GSC opportunity detection scheduled: daily at 7 AM (0 7 * * *)');

  // GA4 engagement refresh detection - daily at 7:30 AM
  cron.schedule('30 7 * * *', async () => {
    await runGa4EngagementDetection();
  });
  // eslint-disable-next-line no-console
  console.log('GA4 engagement detection scheduled: daily at 7:30 AM (30 7 * * *)');

  // Content refresh processing - every 6 hours (1 post per run)
  cron.schedule('0 */6 * * *', async () => {
    await runContentRefresh();
  });
  // eslint-disable-next-line no-console
  console.log('Content refresh scheduled: every 6 hours (0 */6 * * *)');

  // CTR title/meta optimization - weekly on Monday at 8 AM
  cron.schedule('0 8 * * 1', async () => {
    await runCtrOptimization();
  });
  // eslint-disable-next-line no-console
  console.log('CTR optimization scheduled: weekly Monday 8 AM (0 8 * * 1)');

  // Log stats immediately on startup
  logDatabaseStats();

  // eslint-disable-next-line no-console
  console.log('Pipeline schedules:', env.CRON_SCHEDULE_1, env.CRON_SCHEDULE_2 ?? '(none)');
}
