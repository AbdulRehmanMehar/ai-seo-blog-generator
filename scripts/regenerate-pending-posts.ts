/**
 * Regenerate posts that are in "rewrite" status but have no reviews.
 * These are typically variant posts that need to be generated fresh with the correct website voice.
 * 
 * Usage:
 *   npx tsx scripts/regenerate-pending-posts.ts
 */

import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { loadAuthorKnowledge } from '../src/knowledge/authorKnowledge.js';
import { env } from '../src/config/env.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { EmbeddingStore } from '../src/embeddings/embeddingStore.js';
import { BlogGenerator } from '../src/services/blogGenerator.js';
import { Humanizer } from '../src/services/humanizer.js';
import { PostReviewer } from '../src/services/postReviewer.js';
import type { RowDataPacket } from 'mysql2/promise';

interface PendingPost extends RowDataPacket {
  id: string;
  title: string;
  topic_id: string;
  website_id: string;
  domain: string;
}

async function main() {
  console.log('\n=== REGENERATE PENDING POSTS ===\n');

  // Find posts in "rewrite" status without reviews
  const [pendingPosts] = await mysqlPool.query<PendingPost[]>(`
    SELECT p.id, p.title, p.topic_id, p.website_id, w.domain
    FROM posts p
    JOIN websites w ON w.id = p.website_id
    LEFT JOIN post_reviews pr ON pr.post_id = p.id
    WHERE p.status = 'rewrite' AND pr.id IS NULL
  `);

  if (pendingPosts.length === 0) {
    console.log('No posts pending regeneration.');
    await mysqlPool.end();
    await postgresPool.end();
    return;
  }

  console.log(`Found ${pendingPosts.length} post(s) to regenerate:`);
  for (const p of pendingPosts) {
    console.log(`  - ${p.title.slice(0, 50)}... (${p.domain})`);
  }
  console.log('');

  // Initialize services
  const apiKeys = env.GEMINI_API_KEYS?.split(',').map(k => k.trim()).filter(Boolean) ?? [];
  if (apiKeys.length === 0 && env.GEMINI_API_KEY) {
    apiKeys.push(env.GEMINI_API_KEY);
  }
  if (apiKeys.length === 0) {
    throw new Error('No Gemini API keys configured');
  }

  const knowledge = await loadAuthorKnowledge();
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
  const embeddings = new EmbeddingStore(postgresPool);
  const blogGenerator = new BlogGenerator({
    pool: mysqlPool,
    gemini,
    knowledge,
    embeddings,
    minWords: env.POST_MIN_WORDS,
  });
  const humanizer = new Humanizer({
    pool: mysqlPool,
    gemini,
    knowledge,
    minWords: env.POST_MIN_WORDS,
  });
  const reviewer = new PostReviewer({ pool: mysqlPool, gemini });

  let succeeded = 0;
  let failed = 0;

  for (const post of pendingPosts) {
    console.log(`\n🔄 Regenerating: ${post.title.slice(0, 50)}...`);
    console.log(`   Website: ${post.domain}`);

    try {
      // Delete the old post
      console.log('   🗑️  Deleting old post...');
      await mysqlPool.query('DELETE FROM posts WHERE id = ?', [post.id]);
      await postgresPool.query(
        'DELETE FROM embeddings WHERE entity_type = $1 AND entity_id = $2',
        ['post', post.id]
      );

      // Generate a new post for the same topic but with correct website voice
      console.log('   ✍️  Generating new draft...');
      const newPostId = await blogGenerator.generateDraftPost(post.topic_id, post.website_id);

      // Humanize
      console.log('   🧹 Humanizing...');
      await humanizer.humanizePost(newPostId);

      // Review
      console.log('   📋 Reviewing...');
      const result = await reviewer.reviewPost(newPostId);
      
      if (result.passed) {
        console.log(`   ✅ PASSED (score: ${result.score}/100) → published`);
      } else {
        console.log(`   ⚠️  FAILED (score: ${result.score}/100) → queued for rewrite`);
      }

      succeeded++;
    } catch (err) {
      console.error(`   ❌ Error:`, err);
      failed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);

  await mysqlPool.end();
  await postgresPool.end();
}

main().catch(console.error);
