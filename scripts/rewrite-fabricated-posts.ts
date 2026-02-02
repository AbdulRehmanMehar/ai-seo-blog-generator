/**
 * Rewrite posts that contain fabricated client stories
 * This script will regenerate the flagged posts with the new anti-fabrication prompts
 * 
 * Usage:
 *   npx tsx scripts/rewrite-fabricated-posts.ts
 *   npx tsx scripts/rewrite-fabricated-posts.ts --dry-run
 */

import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { loadAuthorKnowledge } from '../src/knowledge/authorKnowledge.js';
import { env } from '../src/config/env.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { EmbeddingStore } from '../src/embeddings/embeddingStore.js';
import { BlogGenerator } from '../src/services/blogGenerator.js';
import type { RowDataPacket } from 'mysql2/promise';

interface PostRow extends RowDataPacket {
  id: string;
  topic_id: string;
  title: string;
  primary_keyword: string;
  content_json: string | object;
  status: string;
}

// Posts with fabricated client stories identified by the scan
// NOTE: These posts have already been rewritten. This array is kept for reference.
// To scan for new fabrications, run: node flag-fabricated-posts.js
const FABRICATED_POST_IDS: string[] = [
  // Already fixed - keeping for history:
  // '10ba78c6-5e2f-4adb-bcdb-0980193d622f', // "How to Build AI Powered React Native Apps..."
  // '609c700c-bff9-400e-a54f-3eddc82bf0df', // "Unlock Top-Tier Senior Engineering Talent..."
];

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

async function main() {
  console.log('\n========================================');
  console.log('   REWRITE FABRICATED POSTS');
  console.log('========================================\n');
  
  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be saved\n');
  }

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

  // Fetch the flagged posts
  if (FABRICATED_POST_IDS.length === 0) {
    console.log('ℹ️  No post IDs specified in FABRICATED_POST_IDS array.');
    console.log('   Run flag-fabricated-posts.js to scan for fabrications,');
    console.log('   then add the IDs to this script and run again.\n');
    await mysqlPool.end();
    await postgresPool.end();
    return;
  }

  const [posts] = await mysqlPool.query<PostRow[]>(
    `SELECT id, topic_id, title, primary_keyword, content_json, status
     FROM posts
     WHERE id IN (?)
     ORDER BY created_at DESC`,
    [FABRICATED_POST_IDS]
  );

  if (posts.length === 0) {
    console.log('❌ No posts found with the specified IDs');
    console.log('   (They may have already been deleted/rewritten)');
    await mysqlPool.end();
    await postgresPool.end();
    return;
  }

  console.log(`Found ${posts.length} posts to rewrite:\n`);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const post of posts) {
    processed++;
    console.log(`\n[${processed}/${posts.length}] Rewriting: ${post.title}`);
    console.log(`   ID: ${post.id}`);
    console.log(`   Status: ${post.status}`);

    try {
      // Show the fabricated content before rewriting
      const contentJson = typeof post.content_json === 'string' 
        ? JSON.parse(post.content_json)
        : post.content_json;

      console.log('\n   🔍 Checking for fabrications...');
      const fabricationPatterns = [
        'my client', 'my clients', 'i helped a', 'helped client',
        'save clients', 'client saw', 'customer saw'
      ];

      const contentStr = JSON.stringify(contentJson).toLowerCase();
      const foundPatterns: string[] = [];
      
      fabricationPatterns.forEach(pattern => {
        if (contentStr.includes(pattern)) {
          foundPatterns.push(pattern);
        }
      });

      if (foundPatterns.length > 0) {
        console.log(`   ⚠️  Found fabrications: ${foundPatterns.join(', ')}`);
      }

      if (!isDryRun) {
        console.log('\n   🔄 Deleting old fabricated post first...');
        
        // Delete the old fabricated post FIRST to avoid slug conflicts
        await mysqlPool.query(
          `DELETE FROM posts WHERE id = ?`,
          [post.id]
        );
        
        console.log(`   🗑️  Deleted old post`);
        console.log(`   🔄 Regenerating with anti-fabrication prompts...`);
        
        // Regenerate the post using BlogGenerator (which now has anti-fabrication rules)
        const newPostId = await blogGenerator.generateDraftPost(post.topic_id);
        
        console.log(`   ✅ Generated new draft: ${newPostId}`);
        
        // Verify the new post doesn't have fabrications
        const [newPosts] = await mysqlPool.query<PostRow[]>(
          `SELECT content_json FROM posts WHERE id = ?`,
          [newPostId]
        );
        
        if (newPosts.length > 0) {
          const newContent = typeof newPosts[0].content_json === 'string'
            ? JSON.parse(newPosts[0].content_json)
            : newPosts[0].content_json;
          
          const newContentStr = JSON.stringify(newContent).toLowerCase();
          const stillHasFabrication = fabricationPatterns.some(p => newContentStr.includes(p));
          
          if (stillHasFabrication) {
            console.log(`   ⚠️  WARNING: New post still contains fabrication patterns!`);
          } else {
            console.log(`   ✅ New post is clean (no fabrications detected)`);
          }
        }
        
        succeeded++;
      } else {
        console.log('\n   ✅ Would regenerate and replace (dry run)');
      }

    } catch (err) {
      console.log(`   ❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        console.log(`   Stack: ${err.stack.split('\n').slice(0, 3).join('\n')}`);
      }
      failed++;
    }

    // Delay between posts to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n========================================');
  console.log('   SUMMARY');
  console.log('========================================');
  console.log(`Total posts:     ${posts.length}`);
  console.log(`Processed:       ${processed}`);
  console.log(`Succeeded:       ${succeeded}`);
  console.log(`Failed:          ${failed}`);
  console.log('========================================\n');

  if (!isDryRun && succeeded > 0) {
    console.log('✅ Posts successfully rewritten with anti-fabrication prompts!');
    console.log('   The new posts should only reference real experience from author knowledge.\n');
  }

  await mysqlPool.end();
  await postgresPool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
