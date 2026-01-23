/**
 * Rewrite all posts using AI to ensure they follow the new clean formatting rules:
 * - No colons in text
 * - No em dashes
 * - No markdown formatting
 * - Natural flowing prose
 * 
 * Usage:
 *   npx tsx scripts/rewrite-all-posts.ts
 *   npx tsx scripts/rewrite-all-posts.ts --dry-run   # Preview without saving
 *   npx tsx scripts/rewrite-all-posts.ts --limit 5   # Only process 5 posts
 */

import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { loadAuthorKnowledge } from '../src/knowledge/authorKnowledge.js';
import { env } from '../src/config/env.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import type { RowDataPacket } from 'mysql2/promise';
import type { BlogPostStructure } from '../src/prompts/blogGeneration.js';
import { safeJsonParse } from '../src/utils/json.js';

interface PostRow extends RowDataPacket {
  id: string;
  title: string;
  slug: string;
  primary_keyword: string;
  content_json: string | object;
  status: string;
}

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitIndex = args.indexOf('--limit');
const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1] || '0', 10) : 0;

async function main() {
  console.log('\n========================================');
  console.log('   AI-POWERED POST REWRITER');
  console.log('========================================\n');
  
  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be saved\n');
  }

  // Initialize Gemini
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

  // Fetch all posts
  let query = `
    SELECT id, title, slug, primary_keyword, content_json, status
    FROM posts
    WHERE content_json IS NOT NULL
    ORDER BY created_at DESC
  `;
  
  if (limit > 0) {
    query += ` LIMIT ${limit}`;
  }

  const [posts] = await mysqlPool.query<PostRow[]>(query);

  console.log(`Found ${posts.length} posts to process\n`);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const post of posts) {
    processed++;
    console.log(`\n[${processed}/${posts.length}] Processing: ${post.title.slice(0, 50)}...`);

    try {
      // Parse content JSON
      const contentJson = typeof post.content_json === 'string' 
        ? safeJsonParse<BlogPostStructure>(post.content_json)
        : post.content_json as BlogPostStructure;

      if (!contentJson) {
        console.log('   ⚠️  Skipping - Invalid content JSON');
        skipped++;
        continue;
      }

      // Check if post needs rewriting (has colons, em dashes, or markdown)
      const contentStr = JSON.stringify(contentJson);
      const hasColons = /:\s+[A-Z]/.test(contentStr) || contentJson.title.includes(':');
      const hasEmDash = contentStr.includes('—');
      const hasMarkdown = /\*\*[^*]+\*\*/.test(contentStr) || /^#{1,6}\s/m.test(contentStr);

      if (!hasColons && !hasEmDash && !hasMarkdown) {
        console.log('   ✓  Already clean, skipping');
        skipped++;
        continue;
      }

      console.log(`   🔄 Rewriting (found: ${[hasColons && 'colons', hasEmDash && 'em-dashes', hasMarkdown && 'markdown'].filter(Boolean).join(', ')})`);

      // Build the rewrite prompt
      const prompt = buildRewritePrompt(contentJson, post.primary_keyword);

      // Call Gemini to rewrite
      const response = await gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: prompt.user,
      });

      if (!response) {
        console.log('   ❌ No response from AI');
        failed++;
        continue;
      }

      // Parse the response
      const rewritten = safeJsonParse<BlogPostStructure>(response);
      if (!rewritten) {
        console.log('   ❌ Invalid JSON response');
        failed++;
        continue;
      }

      // Validate the rewritten content
      const rewrittenStr = JSON.stringify(rewritten);
      const stillHasColons = /:\s+[A-Z]/.test(rewrittenStr) || rewritten.title.includes(':');
      const stillHasEmDash = rewrittenStr.includes('—');
      const stillHasMarkdown = /\*\*[^*]+\*\*/.test(rewrittenStr);

      if (stillHasColons || stillHasEmDash || stillHasMarkdown) {
        console.log(`   ⚠️  Rewritten but still has issues: ${[stillHasColons && 'colons', stillHasEmDash && 'em-dashes', stillHasMarkdown && 'markdown'].filter(Boolean).join(', ')}`);
      }

      if (!isDryRun) {
        // Update the post in database
        await mysqlPool.query(
          `UPDATE posts SET content_json = ?, title = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(rewritten), rewritten.title, post.id]
        );
        console.log('   ✅ Saved to database');
      } else {
        console.log('   ✅ Would save (dry run)');
        console.log(`   📝 New title: ${rewritten.title}`);
      }

      succeeded++;

    } catch (err) {
      console.log(`   ❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }

    // Small delay to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n========================================');
  console.log('   SUMMARY');
  console.log('========================================');
  console.log(`Total posts:     ${posts.length}`);
  console.log(`Processed:       ${processed}`);
  console.log(`Succeeded:       ${succeeded}`);
  console.log(`Skipped (clean): ${skipped}`);
  console.log(`Failed:          ${failed}`);
  console.log('========================================\n');

  await mysqlPool.end();
  await postgresPool.end();
}

function buildRewritePrompt(content: BlogPostStructure, keyword: string) {
  return {
    system: `You are an expert editor. Your task is to rewrite blog content to sound completely natural and human.

CRITICAL RULES - You MUST follow these exactly:

1. REMOVE ALL COLONS from titles, headings, and body text
   - Bad: "Software Development: A Complete Guide"
   - Good: "The Complete Guide to Software Development"
   - Bad: "Here's what you need: first, do this"
   - Good: "Here's what you need. First, do this"

2. REMOVE ALL EM DASHES (—) and replace with commas, periods, or "and"
   - Bad: "This is important — you need to understand"
   - Good: "This is important. You need to understand"
   - Bad: "The key factors — speed, cost, and quality"
   - Good: "The key factors are speed, cost, and quality"

3. REMOVE ALL MARKDOWN FORMATTING
   - No **bold** markers
   - No *italic* markers  
   - No # headers
   - No bullet points with - or *
   - Write plain flowing text

4. KEEP THE SAME MEANING AND STRUCTURE
   - Preserve all sections, FAQs, and CTAs
   - Keep the same JSON structure exactly
   - Only change the text content to be cleaner

5. USE CONTRACTIONS NATURALLY
   - "do not" becomes "don't"
   - "it is" becomes "it's"
   - etc.

6. WRITE NATURALLY
   - Text should flow when read aloud
   - Sound like a real person wrote it
   - Be conversational but professional

Return the exact same JSON structure with cleaned content.`,

    user: `KEYWORD: ${keyword}

CONTENT TO REWRITE:
${JSON.stringify(content, null, 2)}

Rewrite this content following all the rules. Return valid JSON only, starting with { and ending with }.
Keep the exact same structure. Only clean up the text content.`
  };
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
