import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import type { GeminiClient } from '../llm/geminiClient.js';
import type { BlogPostStructure } from '../prompts/blogGeneration.js';
import {
  reviewerPrompt,
  AI_VOCABULARY_BLOCKLIST,
  FORBIDDEN_OPENINGS,
  PASS_THRESHOLD,
  BASE_SCORE,
  type ReviewResult,
  type ReviewIssue,
} from '../prompts/reviewer.js';
import { safeJsonParse } from '../utils/json.js';
import { PromptLearner } from './promptLearner.js';

export interface PostReviewerDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
}

interface PostRow extends RowDataPacket {
  id: string;
  title: string;
  slug: string;
  primary_keyword: string;
  content_json: string | object;
  rewrite_count: number;
}

// Zod schema for LLM review response
// Allow score > 100 from LLM (bonuses can push it over), we'll clamp it later
const reviewResponseSchema = z.object({
  score: z.number().min(0).transform(s => Math.min(s, 100)), // Clamp to max 100
  passed: z.boolean(),
  issues: z.array(z.object({
    code: z.string(),
    message: z.string(),
    penalty: z.number(),
    location: z.string().optional(),
    suggestion: z.string().optional(),
  })),
  bonuses: z.array(z.object({
    code: z.string(),
    message: z.string(),
    bonus: z.number(),
  })).optional(),
  rewriteInstructions: z.string().nullable(),
});

export class PostReviewer {
  private readonly promptLearner: PromptLearner;

  constructor(private readonly deps: PostReviewerDeps) {
    this.promptLearner = new PromptLearner(deps.pool);
  }

  /**
   * Get the prompt learner for external access (e.g., generating rules)
   */
  getPromptLearner(): PromptLearner {
    return this.promptLearner;
  }

  /**
   * Review a single post by ID
   */
  async reviewPost(postId: string): Promise<ReviewResult> {
    const [rows] = await this.deps.pool.query<PostRow[]>(
      `SELECT id, title, slug, primary_keyword, content_json, rewrite_count 
       FROM posts WHERE id = ?`,
      [postId]
    );

    const post = rows[0];
    if (!post) throw new Error(`Post not found: ${postId}`);

    let contentJson: BlogPostStructure;
    if (typeof post.content_json === 'string') {
      contentJson = safeJsonParse(post.content_json) as BlogPostStructure;
    } else {
      contentJson = post.content_json as BlogPostStructure;
    }

    // Run automated checks first
    const automatedIssues = this.runAutomatedChecks(contentJson);
    
    // Run LLM review for deeper analysis
    const llmResult = await this.runLLMReview(contentJson, post.primary_keyword);
    
    // Combine results
    const allIssues = [...automatedIssues, ...llmResult.issues];
    const totalPenalty = allIssues.reduce((sum, i) => sum + Math.abs(i.penalty), 0);
    const totalBonus = llmResult.bonuses?.reduce((sum, b) => sum + b.bonus, 0) ?? 0;
    
    const finalScore = Math.max(0, Math.min(100, BASE_SCORE - totalPenalty + totalBonus));
    const passed = finalScore >= PASS_THRESHOLD;

    const result: ReviewResult = {
      score: finalScore,
      passed,
      issues: allIssues,
      rewriteInstructions: passed ? null : this.generateRewriteInstructions(allIssues, llmResult.rewriteInstructions),
    };

    // Save review to database
    await this.saveReview(postId, post.rewrite_count + 1, result);

    // Update post status based on result
    await this.updatePostStatus(postId, result, post.rewrite_count);

    return result;
  }

  /**
   * Review all posts with 'draft' status
   */
  async reviewDraftPosts(): Promise<{ reviewed: number; passed: number; failed: number }> {
    const [rows] = await this.deps.pool.query<PostRow[]>(
      `SELECT id FROM posts WHERE status = 'draft' ORDER BY created_at ASC LIMIT 10`
    );

    let passed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const result = await this.reviewPost(row.id);
        if (result.passed) passed++;
        else failed++;
      } catch (err) {
        console.error(`Failed to review post ${row.id}:`, err);
      }
    }

    return { reviewed: rows.length, passed, failed };
  }

  /**
   * Run automated checks that don't need LLM
   */
  private runAutomatedChecks(content: BlogPostStructure): ReviewIssue[] {
    const issues: ReviewIssue[] = [];
    const fullText = this.extractFullText(content);

    // Check for colon in title
    if (content.title.includes(':')) {
      issues.push({
        code: 'COLON_IN_TITLE',
        message: `Title contains colon: "${content.title}"`,
        penalty: -25,
        location: 'title',
        suggestion: 'Rewrite without colon. Use "How to X" or "X That Y" format instead.',
      });
    }

    // Check for AI vocabulary
    for (const word of AI_VOCABULARY_BLOCKLIST) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = fullText.match(regex);
      if (matches) {
        issues.push({
          code: 'AI_VOCABULARY',
          message: `AI vocabulary found: "${word}" (${matches.length} instance${matches.length > 1 ? 's' : ''})`,
          penalty: -10 * matches.length,
          suggestion: `Replace "${word}" with a more natural alternative.`,
        });
      }
    }

    // Check opening hook for forbidden patterns
    const hook = content.hero?.hook || '';
    for (const pattern of FORBIDDEN_OPENINGS) {
      if (pattern.test(hook)) {
        issues.push({
          code: 'FORBIDDEN_OPENING',
          message: `Opening hook uses forbidden pattern: "${hook.substring(0, 50)}..."`,
          penalty: -20,
          location: 'hero.hook',
          suggestion: 'Start with pain point, surprising stat, bold claim, or story instead.',
        });
        break;
      }
    }

    // Check FAQ answer lengths
    content.faq?.forEach((faq, idx) => {
      const wordCount = faq.answer.split(/\s+/).length;
      if (wordCount > 25) {
        issues.push({
          code: 'FAQ_TOO_LONG',
          message: `FAQ #${idx + 1} answer is ${wordCount} words (max 25)`,
          penalty: -5,
          location: `faq:${idx + 1}`,
          suggestion: 'Cut to one punchy sentence. Lead with direct answer.',
        });
      }
    });

    // Check section lengths
    content.sections?.forEach((section, idx) => {
      const wordCount = section.content.split(/\s+/).length;
      if (wordCount > 150) {
        issues.push({
          code: 'SECTION_TOO_LONG',
          message: `Section "${section.heading}" is ${wordCount} words (max 150)`,
          penalty: -5,
          location: `section:${section.id}`,
          suggestion: 'Split into two sections or cut ruthlessly.',
        });
      }
    });

    // Check for mid-article CTAs
    const sectionsWithCta = content.sections?.filter(s => {
      if (!s.cta) return false;
      // Handle both string and object CTAs
      if (typeof s.cta === 'string') return s.cta.trim() !== '';
      if (typeof s.cta === 'object') return true; // Object CTA is valid
      return false;
    }).length ?? 0;
    if (sectionsWithCta < 2) {
      issues.push({
        code: 'MISSING_MID_CTAS',
        message: `Only ${sectionsWithCta} sections have CTAs (need 2-3)`,
        penalty: -15,
        suggestion: 'Add short CTAs to sections 3, 5, and 7.',
      });
    }

    // Check for colon-after-bold pattern
    const colonBoldMatches = fullText.match(/\*\*[^*]+\*\*:\s/g);
    if (colonBoldMatches) {
      issues.push({
        code: 'COLON_AFTER_BOLD',
        message: `Uses "**bold:** text" pattern (${colonBoldMatches.length} instances)`,
        penalty: -5 * colonBoldMatches.length,
        suggestion: 'Change to "**bold.** text" or "**bold** — text"',
      });
    }

    // Check title-content alignment for numbered posts
    const numberMatch = content.title.match(/^(\d+)\s/);
    if (numberMatch && numberMatch[1]) {
      const expectedCount = parseInt(numberMatch[1], 10);
      const numberedSections = content.sections?.filter(s => /^\d+\./.test(s.heading)).length ?? 0;
      if (numberedSections < expectedCount) {
        issues.push({
          code: 'TITLE_CONTENT_MISMATCH',
          message: `Title promises ${expectedCount} items but only ${numberedSections} numbered sections found`,
          penalty: -20,
          location: 'sections',
          suggestion: `Add ${expectedCount - numberedSections} more numbered sections or change the title.`,
        });
      }
    }

    return issues;
  }

  /**
   * Run LLM-based review for deeper analysis
   */
  private async runLLMReview(content: BlogPostStructure, keyword: string): Promise<{
    issues: ReviewIssue[];
    bonuses?: Array<{ code: string; message: string; bonus: number }>;
    rewriteInstructions: string | null;
  }> {
    const prompt = reviewerPrompt({ contentJson: content, keyword });

    try {
      const raw = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: prompt.user,
        temperature: 0.3, // Low temp for consistent judgment
        maxOutputTokens: 4096,
      });

      const parsed = safeJsonParse(raw);
      const validated = reviewResponseSchema.parse(parsed);

      return {
        issues: validated.issues.map(i => ({
          ...i,
          penalty: i.penalty < 0 ? i.penalty : -Math.abs(i.penalty), // Ensure negative
        })),
        bonuses: validated.bonuses,
        rewriteInstructions: validated.rewriteInstructions,
      };
    } catch (err) {
      console.error('LLM review failed, using automated checks only:', err);
      return { issues: [], rewriteInstructions: null };
    }
  }

  /**
   * Extract all text content for searching
   */
  private extractFullText(content: BlogPostStructure): string {
    const parts = [
      content.title,
      content.meta?.title,
      content.meta?.description,
      content.hero?.hook,
      content.hero?.subtitle,
      ...(content.sections?.map(s => `${s.heading} ${s.content}`) ?? []),
      ...(content.faq?.map(f => `${f.question} ${f.answer}`) ?? []),
      content.conclusion?.summary,
      content.conclusion?.cta?.text,
    ];
    return parts.filter(Boolean).join(' ');
  }

  /**
   * Generate comprehensive rewrite instructions from issues
   */
  private generateRewriteInstructions(issues: ReviewIssue[], llmInstructions: string | null): string {
    const sections = [
      '## REWRITE REQUIRED',
      '',
      '### Issues to Fix:',
      ...issues.map(i => `- **${i.code}**: ${i.message}${i.suggestion ? `\n  → ${i.suggestion}` : ''}`),
      '',
    ];

    if (llmInstructions) {
      sections.push('### Additional Instructions:', llmInstructions, '');
    }

    sections.push(
      '### General Guidelines:',
      '- Remove ALL AI vocabulary',
      '- Ensure contractions throughout (don\'t, won\'t, it\'s)',
      '- Add specific numbers and examples',
      '- Include at least one contrarian take',
      '- Keep FAQ answers under 25 words',
      '- Keep sections under 150 words',
    );

    return sections.join('\n');
  }

  /**
   * Save review result to database and learn from failures
   */
  private async saveReview(postId: string, attemptNumber: number, result: ReviewResult): Promise<void> {
    const reviewId = crypto.randomUUID();
    await this.deps.pool.query<ResultSetHeader>(
      `INSERT INTO post_reviews (id, post_id, attempt_number, score, passed, issues_json, rewrite_instructions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        reviewId,
        postId,
        attemptNumber,
        result.score,
        result.passed,
        JSON.stringify(result.issues),
        result.rewriteInstructions,
      ]
    );

    // If review failed, learn from the issues to improve future generation
    if (!result.passed && result.issues.length > 0) {
      try {
        const issuesForLearning = result.issues.map(i => ({
          postId,
          reviewId,
          code: i.code,
          message: i.message,
          location: i.location,
        }));
        const learned = await this.promptLearner.learnFromReview(issuesForLearning);
        if (learned > 0) {
          console.log(`   📚 Learned ${learned} new rule(s) from this review`);
        }
      } catch (err) {
        // Don't fail the review if learning fails
        console.error('Failed to record learnings:', err);
      }
    }
  }

  /**
   * Update post status based on review result
   */
  private async updatePostStatus(postId: string, result: ReviewResult, currentRewriteCount: number): Promise<void> {
    if (result.passed) {
      // Passed! Mark as published
      await this.deps.pool.query<ResultSetHeader>(
        `UPDATE posts SET status = 'published', updated_at = NOW() WHERE id = ?`,
        [postId]
      );
      console.log(`✅ Post ${postId} PASSED review (score: ${result.score}) → published`);
    } else if (currentRewriteCount >= 2) {
      // Failed after 2 rewrites → mark for deletion
      await this.deps.pool.query<ResultSetHeader>(
        `UPDATE posts SET status = 'to_be_deleted', updated_at = NOW() WHERE id = ?`,
        [postId]
      );
      console.log(`❌ Post ${postId} FAILED after 2 rewrites (score: ${result.score}) → to_be_deleted`);
    } else {
      // Failed but has retries left → mark for rewrite
      await this.deps.pool.query<ResultSetHeader>(
        `UPDATE posts SET status = 'rewrite', rewrite_count = rewrite_count + 1, updated_at = NOW() WHERE id = ?`,
        [postId]
      );
      console.log(`🔄 Post ${postId} FAILED review (score: ${result.score}) → rewrite (attempt ${currentRewriteCount + 1}/2)`);
    }
  }
}
