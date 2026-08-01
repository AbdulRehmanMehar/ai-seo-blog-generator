import { z } from 'zod';
import { safeJsonParse } from '../utils/json.js';
import type { GeminiClient } from '../llm/geminiClient.js';
import type { SolutionsPageContent } from './solutionsService.js';
import { solutionsReviewerPrompt, SOLUTIONS_BASE_SCORE, SOLUTIONS_PASS_THRESHOLD } from '../prompts/solutionsReviewer.js';

export interface SolutionsReviewIssue {
  code: string;
  message: string;
  penalty: number;
}

export interface SolutionsReviewBonus {
  code: string;
  message: string;
  bonus: number;
}

export interface SolutionsReviewResult {
  score: number;
  passed: boolean;
  issues: SolutionsReviewIssue[];
  bonuses: SolutionsReviewBonus[];
  rewriteInstructions: string | null;
}

const reviewResponseSchema = z.object({
  score: z.number(),
  passed: z.boolean(),
  issues: z.array(z.object({ code: z.string(), message: z.string(), penalty: z.number() })),
  bonuses: z.array(z.object({ code: z.string(), message: z.string(), bonus: z.number() })).optional(),
  rewriteInstructions: z.string().nullable()
});

/**
 * Runs one LLM-judged holistic review pass over already-generated solutions-page
 * content. A plain function, not a stateful class like blog's PostReviewer — this
 * runs as one step inside SolutionsService.generateSolutionContent()'s existing
 * retry loop, not as an independent job iterating `WHERE status='draft'` the way
 * blog's reviewer does, so it has no DB pool dependency of its own.
 */
export async function reviewSolutionContent(args: {
  gemini: GeminiClient;
  content: SolutionsPageContent;
  serviceName: string;
  /** For service-level pages, pass a cross-industry label instead of a niche name. */
  nicheName: string;
}): Promise<SolutionsReviewResult> {
  const prompt = solutionsReviewerPrompt({
    content: args.content,
    serviceName: args.serviceName,
    nicheName: args.nicheName
  });

  try {
    const raw = await args.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.3,
      // 4096: at 2048 the review JSON was observed truncating (2026-08-01) — the
      // salvaged fragment parsed but lacked `score`, silently triggering the
      // pass-through fallback below and masking that no genuine review ran.
      maxOutputTokens: 4096
    });

    const validated = reviewResponseSchema.parse(safeJsonParse(raw));
    const issues: SolutionsReviewIssue[] = validated.issues.map((i) => ({
      ...i,
      penalty: i.penalty < 0 ? i.penalty : -Math.abs(i.penalty)
    }));
    const bonuses: SolutionsReviewBonus[] = validated.bonuses ?? [];

    const totalPenalty = issues.reduce((sum, i) => sum + Math.abs(i.penalty), 0);
    const totalBonus = bonuses.reduce((sum, b) => sum + b.bonus, 0);
    const score = Math.max(0, Math.min(100, SOLUTIONS_BASE_SCORE - totalPenalty + totalBonus));

    return { score, passed: score >= SOLUTIONS_PASS_THRESHOLD, issues, bonuses, rewriteInstructions: validated.rewriteInstructions };
  } catch (err) {
    // Mirrors postReviewer.ts's fallback: an invalid/unparseable LLM response never
    // blocks the pipeline — treat as a pass-through rather than a hard failure, since
    // the deterministic screen already ran and this is a supplementary judgment layer.
    const errMsg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 150);
    // eslint-disable-next-line no-console
    console.log(`[SolutionsReviewer] ⚠️ LLM review invalid response, treating as pass: ${errMsg}`);
    return { score: SOLUTIONS_BASE_SCORE, passed: true, issues: [], bonuses: [], rewriteInstructions: null };
  }
}
