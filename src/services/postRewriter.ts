import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import type { GeminiClient } from '../llm/geminiClient.js';
import type { BlogPostStructure } from '../prompts/blogGeneration.js';
import { rewriterPrompt, type ReviewResult } from '../prompts/reviewer.js';
import { safeJsonParse } from '../utils/json.js';
import { PromptLearner } from './promptLearner.js';
import { postHumanizer } from './postHumanizer.js';

export interface PostRewriterDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
}

interface RewritePostRow extends RowDataPacket {
  id: string;
  title: string;
  slug: string;
  primary_keyword: string;
  content_json: string | object;
  rewrite_count: number;
}

interface ReviewRow extends RowDataPacket {
  issues_json: string | object;
  rewrite_instructions: string | null;
  score: number;
}

// Zod schema matching BlogPostStructure for validation
const sectionSchema = z.object({
  id: z.string(),
  heading: z.string(),
  level: z.union([z.literal(2), z.literal(3)]),
  content: z.string(),
  keyTakeaway: z.string().nullable(),
  // Accept string, object, or null for CTA (LLM sometimes returns objects)
  cta: z.union([z.string(), z.record(z.any())]).nullable().optional().transform(v => v ?? null),
});

const blogJsonSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),
  meta: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    keywords: z.array(z.string()),
  }),
  hero: z.object({
    hook: z.string().min(1),
    subtitle: z.string(),
  }),
  sections: z.array(sectionSchema).min(1),
  faq: z.array(z.object({
    question: z.string(),
    answer: z.string(),
  })),
  conclusion: z.object({
    summary: z.string(),
    cta: z.object({
      text: z.string(),
      buttonText: z.string(),
      action: z.string(),
    }),
  }),
  internalLinks: z.array(z.string()),
  estimatedReadingMinutes: z.number(),
});

export class PostRewriter {
  private readonly promptLearner: PromptLearner;

  constructor(private readonly deps: PostRewriterDeps) {
    this.promptLearner = new PromptLearner(deps.pool);
  }

  /**
   * Rewrite a single post based on review feedback
   */
  async rewritePost(postId: string): Promise<boolean> {
    // Get the post
    const [postRows] = await this.deps.pool.query<RewritePostRow[]>(
      `SELECT id, title, slug, primary_keyword, content_json, rewrite_count 
       FROM posts WHERE id = ?`,
      [postId]
    );

    const post = postRows[0];
    if (!post) throw new Error(`Post not found: ${postId}`);

    // Get the latest review with feedback
    const [reviewRows] = await this.deps.pool.query<ReviewRow[]>(
      `SELECT issues_json, rewrite_instructions, score
       FROM post_reviews 
       WHERE post_id = ? 
       ORDER BY reviewed_at DESC 
       LIMIT 1`,
      [postId]
    );

    const review = reviewRows[0];
    if (!review) throw new Error(`No review found for post: ${postId}`);

    let contentJson: BlogPostStructure;
    if (typeof post.content_json === 'string') {
      contentJson = safeJsonParse(post.content_json) as BlogPostStructure;
    } else {
      contentJson = post.content_json as BlogPostStructure;
    }

    // Handle issues_json - may be string or already parsed object from MySQL JSON column
    // Note: penalty field is not stored in DB, default to 0 since it was already applied to score
    type StoredIssue = { code: string; message: string; location?: string; suggestion?: string; penalty?: number };
    let rawIssues: StoredIssue[];
    if (typeof review.issues_json === 'string') {
      rawIssues = JSON.parse(review.issues_json);
    } else {
      rawIssues = review.issues_json as StoredIssue[];
    }
    
    // Ensure penalty field exists for TypeScript
    const issues = rawIssues.map(i => ({
      ...i,
      penalty: i.penalty ?? 0
    }));
    
    const reviewResult: ReviewResult = {
      score: review.score,
      passed: false,
      issues,
      rewriteInstructions: review.rewrite_instructions,
    };

    // Fetch learned rules to improve rewrite quality
    let learnedRules: string | undefined;
    try {
      learnedRules = await this.promptLearner.generatePromptRules();
    } catch (err) {
      console.error('Failed to fetch learned rules:', err);
    }

    // Generate rewrite
    const prompt = rewriterPrompt({
      contentJson,
      keyword: post.primary_keyword,
      reviewResult,
      attemptNumber: post.rewrite_count,
      learnedRules,
    });

    console.log(`🔄 Rewriting post "${post.title}" (attempt ${post.rewrite_count}/2)...`);

    const raw = await this.deps.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.7,
      maxOutputTokens: 8192,
    });

    // Parse and validate the rewritten content
    let rewrittenContent: BlogPostStructure;
    try {
      const parsed = safeJsonParse(raw);
      rewrittenContent = blogJsonSchema.parse(parsed) as BlogPostStructure;
    } catch (err) {
      console.error(`Failed to parse rewritten content for post ${postId}:`, err);
      // Try one more time with stricter instructions
      const retryRaw = await this.deps.gemini.generateText({
        systemInstruction: 'You must output valid JSON only. No markdown, no explanation. Start with { and end with }.',
        userPrompt: `Fix this JSON and return valid JSON:\n${raw}`,
        temperature: 0.3,
        maxOutputTokens: 8192,
      });
      
      try {
        const retryParsed = safeJsonParse(retryRaw);
        rewrittenContent = blogJsonSchema.parse(retryParsed) as BlogPostStructure;
      } catch {
        console.error(`Retry also failed for post ${postId}`);
        return false;
      }
    }

    // Post-processing: Humanize the rewritten content to clean any remaining AI patterns
    const { post: humanizedContent, changes } = postHumanizer.humanize(rewrittenContent);
    rewrittenContent = humanizedContent;
    if (changes.length > 0) {
      console.log(`   🧹 Post-humanization: ${changes.join(', ')}`);
    }

    // Update the post with rewritten content, set status back to draft for re-review
    await this.deps.pool.query<ResultSetHeader>(
      `UPDATE posts 
       SET content_json = ?, 
           title = ?,
           meta_title = ?,
           meta_description = ?,
           status = 'draft',
           updated_at = NOW()
       WHERE id = ?`,
      [
        JSON.stringify(rewrittenContent),
        rewrittenContent.title,
        rewrittenContent.meta.title,
        rewrittenContent.meta.description,
        postId,
      ]
    );

    console.log(`✅ Post "${post.title}" rewritten → status: draft (ready for re-review)`);
    return true;
  }

  /**
   * Rewrite all posts with 'rewrite' status
   */
  async rewritePendingPosts(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const [rows] = await this.deps.pool.query<RewritePostRow[]>(
      `SELECT id FROM posts WHERE status = 'rewrite' ORDER BY updated_at ASC LIMIT 5`
    );

    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const success = await this.rewritePost(row.id);
        if (success) succeeded++;
        else failed++;
      } catch (err) {
        console.error(`Failed to rewrite post ${row.id}:`, err);
        failed++;
      }
    }

    return { processed: rows.length, succeeded, failed };
  }
}
