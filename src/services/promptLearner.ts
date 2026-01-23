import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { randomUUID } from 'crypto';

/**
 * Learning categories for organizing rules
 */
export type LearningCategory = 
  | 'vocabulary'      // Forbidden words/phrases
  | 'structure'       // Section limits, FAQ length, etc.
  | 'formatting'      // Bold patterns, list formatting
  | 'tone'            // Voice, contractions, hedging
  | 'seo'             // Title patterns, keyword usage
  | 'cta'             // Call-to-action placement
  | 'content';        // Topic coverage, depth

export type RuleType =
  | 'forbidden_word'
  | 'forbidden_phrase'
  | 'max_length'
  | 'min_count'
  | 'required_pattern'
  | 'forbidden_pattern';

export interface PromptLearning {
  id: string;
  category: LearningCategory;
  ruleType: RuleType;
  ruleValue: string;
  reason: string;
  failureCount: number;
  lastFailureAt: Date;
  createdAt: Date;
  isActive: boolean;
}

interface LearningRow extends RowDataPacket {
  id: string;
  category: LearningCategory;
  rule_type: RuleType;
  rule_value: string;
  reason: string;
  failure_count: number;
  last_failure_at: Date;
  created_at: Date;
  is_active: boolean;
}

export interface ReviewIssueInput {
  postId: string;
  reviewId: string;
  code: string;
  message: string;
  location?: string;
}

/**
 * PromptLearner analyzes review failures and extracts learnable rules
 * to improve future content generation.
 */
export class PromptLearner {
  constructor(private readonly pool: MysqlPool) {}

  /**
   * Process review issues and extract learnable patterns
   */
  async learnFromReview(issues: ReviewIssueInput[]): Promise<number> {
    let learned = 0;

    for (const issue of issues) {
      const learnings = this.extractLearnings(issue);
      
      for (const learning of learnings) {
        const added = await this.addOrUpdateLearning(
          learning.category,
          learning.ruleType,
          learning.ruleValue,
          learning.reason,
          issue.postId,
          issue.reviewId,
          issue.code
        );
        if (added) learned++;
      }
    }

    return learned;
  }

  /**
   * Extract learnable rules from a single issue
   */
  private extractLearnings(issue: ReviewIssueInput): Array<{
    category: LearningCategory;
    ruleType: RuleType;
    ruleValue: string;
    reason: string;
  }> {
    const learnings: Array<{
      category: LearningCategory;
      ruleType: RuleType;
      ruleValue: string;
      reason: string;
    }> = [];

    // AI Vocabulary issues -> forbidden words
    if (issue.code === 'AI_VOCABULARY') {
      const wordMatch = issue.message.match(/["']([^"']+)["']/);
      if (wordMatch && wordMatch[1]) {
        learnings.push({
          category: 'vocabulary',
          ruleType: 'forbidden_word',
          ruleValue: wordMatch[1].toLowerCase(),
          reason: `Flagged as AI vocabulary: "${issue.message}"`
        });
      }
    }

    // Forbidden opening patterns
    if (issue.code === 'FORBIDDEN_OPENING_PATTERN') {
      learnings.push({
        category: 'tone',
        ruleType: 'forbidden_pattern',
        ruleValue: 'generic_opening',
        reason: 'Content started with a forbidden AI-style opening pattern'
      });
    }

    // Section too long -> reinforce max length
    if (issue.code === 'SECTION_TOO_LONG') {
      const wordMatch = issue.message.match(/(\d+)\s*words/);
      if (wordMatch) {
        learnings.push({
          category: 'structure',
          ruleType: 'max_length',
          ruleValue: 'section:150',
          reason: `Section exceeded 150 words (was ${wordMatch[1]} words)`
        });
      }
    }

    // FAQ too long
    if (issue.code === 'FAQ_TOO_LONG') {
      const wordMatch = issue.message.match(/(\d+)\s*words/);
      if (wordMatch) {
        learnings.push({
          category: 'structure',
          ruleType: 'max_length',
          ruleValue: 'faq_answer:25',
          reason: `FAQ answer exceeded 25 words (was ${wordMatch[1]} words)`
        });
      }
    }

    // Missing CTAs
    if (issue.code === 'MISSING_MID_ARTICLE_CTAS' || issue.code === 'MISSING_MID_ARTICLE_CTAs') {
      learnings.push({
        category: 'cta',
        ruleType: 'min_count',
        ruleValue: 'mid_article_cta:2',
        reason: 'Missing mid-article CTAs (need 2-3 per post)'
      });
    }

    // Colon in title
    if (issue.code === 'COLON_IN_TITLE') {
      learnings.push({
        category: 'seo',
        ruleType: 'forbidden_pattern',
        ruleValue: 'colon_in_title',
        reason: 'Title contained colon (AI pattern)'
      });
    }

    // Title-content mismatch
    if (issue.code === 'TITLE_CONTENT_MISMATCH') {
      learnings.push({
        category: 'content',
        ruleType: 'required_pattern',
        ruleValue: 'title_promise_fulfillment',
        reason: issue.message
      });
    }

    // Colon after bold
    if (issue.code === 'COLON_AFTER_BOLD') {
      learnings.push({
        category: 'formatting',
        ruleType: 'forbidden_pattern',
        ruleValue: 'bold_colon',
        reason: 'Used "**Bold:** text" pattern instead of "**Bold.** text"'
      });
    }

    // Hedge words
    if (issue.code === 'HEDGE_WORDS') {
      const wordMatch = issue.message.match(/["']([^"']+)["']/);
      if (wordMatch && wordMatch[1]) {
        learnings.push({
          category: 'tone',
          ruleType: 'forbidden_phrase',
          ruleValue: wordMatch[1].toLowerCase(),
          reason: `Hedge phrase weakens authority: "${wordMatch[1]}"`
        });
      }
    }

    // Missing contractions
    if (issue.code === 'MISSING_CONTRACTIONS') {
      learnings.push({
        category: 'tone',
        ruleType: 'required_pattern',
        ruleValue: 'use_contractions',
        reason: 'Content should use contractions (don\'t, won\'t, it\'s) for natural voice'
      });
    }

    return learnings;
  }

  /**
   * Add a new learning or increment failure count if it exists
   */
  private async addOrUpdateLearning(
    category: LearningCategory,
    ruleType: RuleType,
    ruleValue: string,
    reason: string,
    postId: string,
    reviewId: string,
    issueCode: string
  ): Promise<boolean> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // Try to find existing learning
      const [existing] = await conn.query<LearningRow[]>(
        `SELECT id, failure_count FROM prompt_learnings 
         WHERE category = ? AND rule_type = ? AND rule_value = ?`,
        [category, ruleType, ruleValue]
      );

      let learningId: string;

      if (existing.length > 0 && existing[0]) {
        // Update existing learning
        learningId = existing[0].id;
        await conn.query(
          `UPDATE prompt_learnings 
           SET failure_count = failure_count + 1, 
               last_failure_at = NOW(),
               reason = CONCAT(reason, ' | ', ?)
           WHERE id = ?`,
          [reason.slice(0, 200), learningId]
        );
      } else {
        // Insert new learning
        learningId = randomUUID();
        await conn.query(
          `INSERT INTO prompt_learnings (id, category, rule_type, rule_value, reason, failure_count, last_failure_at)
           VALUES (?, ?, ?, ?, ?, 1, NOW())`,
          [learningId, category, ruleType, ruleValue, reason]
        );
      }

      // Record the source
      await conn.query(
        `INSERT INTO learning_sources (id, learning_id, post_id, review_id, issue_code)
         VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), learningId, postId, reviewId, issueCode]
      );

      await conn.commit();
      return existing.length === 0; // Return true if new learning
    } catch (err) {
      await conn.rollback();
      // Ignore duplicate key errors for sources
      if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') {
        throw err;
      }
      return false;
    } finally {
      conn.release();
    }
  }

  /**
   * Get all active learnings, ordered by failure count
   */
  async getActiveLearnings(): Promise<PromptLearning[]> {
    const [rows] = await this.pool.query<LearningRow[]>(
      `SELECT * FROM prompt_learnings 
       WHERE is_active = TRUE 
       ORDER BY failure_count DESC, last_failure_at DESC`
    );

    return rows.map(row => ({
      id: row.id,
      category: row.category,
      ruleType: row.rule_type,
      ruleValue: row.rule_value,
      reason: row.reason,
      failureCount: row.failure_count,
      lastFailureAt: row.last_failure_at,
      createdAt: row.created_at,
      isActive: row.is_active
    }));
  }

  /**
   * Get learnings by category
   */
  async getLearningsByCategory(category: LearningCategory): Promise<PromptLearning[]> {
    const [rows] = await this.pool.query<LearningRow[]>(
      `SELECT * FROM prompt_learnings 
       WHERE category = ? AND is_active = TRUE 
       ORDER BY failure_count DESC`,
      [category]
    );

    return rows.map(row => ({
      id: row.id,
      category: row.category,
      ruleType: row.rule_type,
      ruleValue: row.rule_value,
      reason: row.reason,
      failureCount: row.failure_count,
      lastFailureAt: row.last_failure_at,
      createdAt: row.created_at,
      isActive: row.is_active
    }));
  }

  /**
   * Generate prompt rules from learnings for injection into generation prompts
   */
  async generatePromptRules(): Promise<string> {
    const learnings = await this.getActiveLearnings();
    
    if (learnings.length === 0) {
      return '';
    }

    const sections: string[] = [];

    // Group by category
    const byCategory = new Map<LearningCategory, PromptLearning[]>();
    for (const l of learnings) {
      const existing = byCategory.get(l.category) || [];
      existing.push(l);
      byCategory.set(l.category, existing);
    }

    // Vocabulary rules (forbidden words)
    const vocabRules = byCategory.get('vocabulary') || [];
    if (vocabRules.length > 0) {
      const words = vocabRules
        .filter(r => r.ruleType === 'forbidden_word')
        .map(r => r.ruleValue);
      
      if (words.length > 0) {
        sections.push(`LEARNED FORBIDDEN WORDS (failed ${vocabRules.reduce((s, r) => s + r.failureCount, 0)} times total):
${words.map(w => `- "${w}"`).join('\n')}
NEVER use these words. They are detected as AI-generated patterns.`);
      }
    }

    // Structure rules
    const structureRules = byCategory.get('structure') || [];
    if (structureRules.length > 0) {
      const rules: string[] = [];
      for (const r of structureRules) {
        if (r.ruleType === 'max_length') {
          const parts = r.ruleValue.split(':');
          const target = parts[0] ?? 'item';
          const limit = parts[1] ?? '150';
          rules.push(`- ${target.toUpperCase()}: Maximum ${limit} words (violated ${r.failureCount}x)`);
        }
      }
      if (rules.length > 0) {
        sections.push(`STRICT LENGTH LIMITS (these have been violated multiple times):
${rules.join('\n')}
COUNT YOUR WORDS. Exceeding these limits will cause rejection.`);
      }
    }

    // CTA rules
    const ctaRules = byCategory.get('cta') || [];
    if (ctaRules.length > 0) {
      const minCta = ctaRules.find(r => r.ruleType === 'min_count');
      if (minCta) {
        const [, count] = minCta.ruleValue.split(':');
        sections.push(`REQUIRED CTAs (missing in ${minCta.failureCount} posts):
- Include at least ${count} mid-article CTAs spread across sections
- Each CTA should be a natural call to action, not generic
- Example: "Want help building your dev team? Let's talk." in the section's cta field`);
      }
    }

    // Tone rules
    const toneRules = byCategory.get('tone') || [];
    if (toneRules.length > 0) {
      const forbidden = toneRules.filter(r => r.ruleType === 'forbidden_phrase' || r.ruleType === 'forbidden_pattern');
      const required = toneRules.filter(r => r.ruleType === 'required_pattern');
      
      const toneLines: string[] = [];
      
      if (forbidden.length > 0) {
        const patterns = forbidden.map(r => {
          if (r.ruleValue === 'generic_opening') {
            return '- NO generic openings like "In today\'s...", "Let\'s dive into...", "In this article..."';
          }
          return `- Avoid: "${r.ruleValue}"`;
        });
        toneLines.push(...patterns);
      }
      
      if (required.length > 0) {
        for (const r of required) {
          if (r.ruleValue === 'use_contractions') {
            toneLines.push('- ALWAYS use contractions: don\'t, won\'t, can\'t, it\'s, you\'re, we\'ve');
          }
        }
      }
      
      if (toneLines.length > 0) {
        sections.push(`TONE & VOICE REQUIREMENTS:
${toneLines.join('\n')}`);
      }
    }

    // Formatting rules
    const formatRules = byCategory.get('formatting') || [];
    if (formatRules.length > 0) {
      const rules: string[] = [];
      for (const r of formatRules) {
        if (r.ruleValue === 'bold_colon') {
          rules.push('- NEVER use "**Bold:** text" - use "**Bold.** text" or "**Bold** — text" instead');
        }
      }
      if (rules.length > 0) {
        sections.push(`FORMATTING RULES:
${rules.join('\n')}`);
      }
    }

    // SEO rules
    const seoRules = byCategory.get('seo') || [];
    if (seoRules.length > 0) {
      const rules: string[] = [];
      for (const r of seoRules) {
        if (r.ruleValue === 'colon_in_title') {
          rules.push(`- NO colons in titles (rejected ${r.failureCount}x). Use "How to X" or "X That Y" formats.`);
        }
      }
      if (rules.length > 0) {
        sections.push(`SEO & TITLE RULES:
${rules.join('\n')}`);
      }
    }

    // Content rules
    const contentRules = byCategory.get('content') || [];
    if (contentRules.length > 0) {
      const rules: string[] = [];
      for (const r of contentRules) {
        if (r.ruleValue === 'title_promise_fulfillment') {
          rules.push('- If title promises N items (e.g., "7 Mistakes"), include exactly N clearly numbered sections');
        }
      }
      if (rules.length > 0) {
        sections.push(`CONTENT STRUCTURE:
${rules.join('\n')}`);
      }
    }

    if (sections.length === 0) {
      return '';
    }

    return `
═══════════════════════════════════════════════════════════════
LEARNED RULES FROM PAST FAILURES (${learnings.length} rules, ${learnings.reduce((s, l) => s + l.failureCount, 0)} total violations)
These rules were learned from content that failed review. FOLLOW THEM STRICTLY.
═══════════════════════════════════════════════════════════════

${sections.join('\n\n')}

═══════════════════════════════════════════════════════════════
`;
  }

  /**
   * Get statistics about learnings
   */
  async getStats(): Promise<{
    totalLearnings: number;
    totalFailures: number;
    byCategory: Record<string, number>;
    topViolations: Array<{ rule: string; count: number }>;
  }> {
    const learnings = await this.getActiveLearnings();
    
    const byCategory: Record<string, number> = {};
    for (const l of learnings) {
      byCategory[l.category] = (byCategory[l.category] || 0) + l.failureCount;
    }

    const topViolations = learnings
      .slice(0, 10)
      .map(l => ({
        rule: `${l.category}:${l.ruleType}:${l.ruleValue}`,
        count: l.failureCount
      }));

    return {
      totalLearnings: learnings.length,
      totalFailures: learnings.reduce((s, l) => s + l.failureCount, 0),
      byCategory,
      topViolations
    };
  }
}
