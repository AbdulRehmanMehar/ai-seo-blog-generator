import { mysqlPool } from '../src/db/mysqlPool.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { PostReviewer } from '../src/services/postReviewer.js';
import { PostRewriter } from '../src/services/postRewriter.js';
import { env } from '../src/config/env.js';
import type { RowDataPacket } from 'mysql2/promise';

interface PostRow extends RowDataPacket {
  id: string;
  title: string;
  status: string;
  rewrite_count: number;
}

async function main() {
  console.log('🧪 Testing Review & Rewrite System\n');

  const pool = mysqlPool;
  
  // Parse API keys using the same utility as orchestrator
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  
  if (apiKeys.length === 0) {
    throw new Error('No Gemini API keys configured');
  }

  console.log(`🔑 Using ${apiKeys.length} API key(s)\n`);

  // Initialize rate limiter and client (same pattern as orchestrator)
  const rateLimiter = new GeminiRateLimiter(pool, apiKeys);
  
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS
  });

  const reviewer = new PostReviewer({ pool, gemini });
  const rewriter = new PostRewriter({ pool, gemini });

  // Check for draft posts
  const [draftPosts] = await pool.query<PostRow[]>(
    `SELECT id, title, status, rewrite_count FROM posts WHERE status = 'draft' ORDER BY created_at DESC LIMIT 3`
  );

  console.log(`📋 Found ${draftPosts.length} draft posts\n`);

  if (draftPosts.length === 0) {
    // Check for any posts to test with
    const [anyPosts] = await pool.query<PostRow[]>(
      `SELECT id, title, status, rewrite_count FROM posts ORDER BY created_at DESC LIMIT 3`
    );
    console.log('All posts:');
    for (const p of anyPosts) {
      console.log(`  - ${p.title} (${p.status}, rewrites: ${p.rewrite_count})`);
    }
    console.log('\nNo draft posts to test. Update a post to draft status first.');
    await pool.end();
    return;
  }

  // Test reviewing each draft post
  for (const post of draftPosts) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📝 Reviewing: "${post.title}"`);
    console.log(`   Status: ${post.status}, Rewrites: ${post.rewrite_count}`);
    console.log('='.repeat(60));

    try {
      const result = await reviewer.reviewPost(post.id);
      
      console.log(`\n📊 Review Result:`);
      console.log(`   Score: ${result.score}/100`);
      console.log(`   Passed: ${result.passed ? '✅ YES' : '❌ NO'}`);
      console.log(`   Issues: ${result.issues.length}`);
      
      if (result.issues.length > 0) {
        console.log('\n   Issues found:');
        for (const issue of result.issues.slice(0, 10)) {
          console.log(`     - [${issue.code}] ${issue.message}`);
          if (issue.location) console.log(`       at: ${issue.location}`);
        }
        if (result.issues.length > 10) {
          console.log(`     ... and ${result.issues.length - 10} more`);
        }
      }

      // Check new status
      const [updated] = await pool.query<PostRow[]>(
        `SELECT status, rewrite_count FROM posts WHERE id = ?`,
        [post.id]
      );
      console.log(`\n   New Status: ${updated[0]?.status}`);

      // If failed and needs rewrite, try rewriting
      if (!result.passed && updated[0]?.status === 'rewrite') {
        console.log(`\n🔄 Attempting rewrite...`);
        const rewriteSuccess = await rewriter.rewritePost(post.id);
        
        if (rewriteSuccess) {
          console.log(`   ✅ Rewrite completed successfully`);
          
          // Check new status after rewrite
          const [afterRewrite] = await pool.query<PostRow[]>(
            `SELECT status, rewrite_count FROM posts WHERE id = ?`,
            [post.id]
          );
          console.log(`   New Status: ${afterRewrite[0]?.status}`);
          console.log(`   Rewrite Count: ${afterRewrite[0]?.rewrite_count}`);
        } else {
          console.log(`   ❌ Rewrite failed`);
        }
      }

    } catch (err) {
      console.error(`   ❌ Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('🏁 Test Complete');
  console.log('='.repeat(60));

  await pool.end();
}

main().catch(console.error);
