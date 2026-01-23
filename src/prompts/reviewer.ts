import type { BlogPostStructure } from './blogGeneration.js';

/**
 * Review criteria with scoring weights
 */
export const REVIEW_CRITERIA = {
  // Instant fails (heavy penalties)
  AI_VOCABULARY: { weight: -10, description: 'AI vocabulary found (delve, leverage, arguably, paramount, etc.)' },
  COLON_IN_TITLE: { weight: -25, description: 'Colon in title (AI pattern)' },
  FORBIDDEN_OPENING: { weight: -20, description: 'Forbidden opening pattern (In today\'s..., Let\'s dive...)' },
  
  // Structural issues
  FAQ_TOO_LONG: { weight: -5, description: 'FAQ answer over 25 words' },
  SECTION_TOO_LONG: { weight: -5, description: 'Section over 150 words' },
  MISSING_MID_CTAS: { weight: -15, description: 'Missing mid-article CTAs' },
  TITLE_CONTENT_MISMATCH: { weight: -20, description: 'Title promises number but content doesn\'t deliver' },
  
  // Voice/tone issues
  NO_CONTRARIAN_TAKE: { weight: -10, description: 'No contrarian or surprising take' },
  WEAK_HOOK: { weight: -15, description: 'Opening hook doesn\'t grab attention' },
  TOO_FORMAL: { weight: -10, description: 'Missing contractions, too formal tone' },
  COLON_AFTER_BOLD: { weight: -5, description: 'Uses **bold:** pattern instead of **bold.** pattern' },
  
  // Positive signals (bonuses)
  SPECIFIC_NUMBERS: { weight: 5, description: 'Uses specific numbers and data' },
  PERSONAL_EXPERIENCE: { weight: 5, description: 'Includes personal experience markers' },
  GOOD_SENTENCE_RHYTHM: { weight: 5, description: 'Varied sentence length, includes short punches' },
};

export const PASS_THRESHOLD = 70;
export const BASE_SCORE = 100;

/**
 * AI vocabulary blocklist for automated checking
 */
export const AI_VOCABULARY_BLOCKLIST = [
  'delve', 'delving',
  'leverage', 'leveraging', 'leveraged',
  'utilize', 'utilizing', 'utilized',
  'arguably',
  'paramount',
  'pivotal',
  'foster', 'fostering',
  'bolster', 'bolstering',
  'boasts',
  'myriad',
  'plethora',
  'facilitate', 'facilitating',
  'robust',
  'seamless', 'seamlessly',
  'cutting-edge',
  'comprehensive',
  'streamline', 'streamlining',
  'synergy',
  'paradigm shift',
  'game-changer',
  'revolutionary',
  'tangible',  // AI tells about tangible benefits
  'landscape', // when used metaphorically
  'navigate', // when used metaphorically about business
  'realm',
  'underscore', 'underscores',
  'spearhead', 'spearheading',
  'endeavor', 'endeavors',
  'multifaceted',
  'innovative',
  'optimize', 'optimizing', 'optimized',
];

export const FORBIDDEN_OPENINGS = [
  /^in today'?s/i,
  /^in the ever-evolving/i,
  /^in this (comprehensive |ultimate |complete )?guide/i,
  /^let'?s dive into/i,
  /^let'?s explore/i,
  /^it'?s no secret that/i,
  /^as businesses continue/i,
  /^when it comes to/i,
  /^it'?s important to note/i,
  /^it'?s worth mentioning/i,
  /^you see[,\s]/i,  // "You see consultants..." pattern
  /^have you ever/i,
  /^imagine if/i,
  /^picture this/i,
];

export const FORBIDDEN_TRANSITIONS = [
  'furthermore',
  'moreover',
  'additionally',
  'it\'s worth noting',
  'it bears mentioning',
  'having said that',
  'that being said',
];

export interface ReviewIssue {
  code: string;
  message: string;
  penalty: number;
  location?: string;
  suggestion?: string;
}

export interface ReviewResult {
  score: number;
  passed: boolean;
  issues: ReviewIssue[];
  rewriteInstructions: string | null;
}

export function reviewerPrompt(args: { contentJson: BlogPostStructure; keyword: string }) {
  return {
    system: `You are a ruthless content quality reviewer. Your job is to ensure blog posts are indistinguishable from expert human writing and optimized for conversions.

You have ZERO tolerance for AI patterns. If content sounds like it was written by ChatGPT/Claude/Gemini, it FAILS.

SCORING SYSTEM (start at 100, deduct penalties):

INSTANT PENALTIES:
- AI vocabulary found: -10 PER INSTANCE (delve, leverage, arguably, paramount, pivotal, foster, bolster, boasts, myriad, plethora, etc.)
- Colon in title: -25 (e.g., "Topic: A Guide" is instant AI detection)
- Forbidden opening patterns: -20 (In today's..., Let's dive..., etc.)

STRUCTURAL PENALTIES:
- FAQ answer over 25 words: -5 per instance
- Section over 150 words: -5 per instance  
- Missing mid-article CTAs (should have 2-3): -15
- Title promises number but content doesn't deliver: -20

VOICE/TONE PENALTIES:
- No contrarian or surprising take: -10
- Weak opening hook (doesn't grab attention): -15
- Too formal (missing contractions, stiff): -10
- Uses "**bold:** text" pattern: -5 per instance

BONUSES:
- Specific numbers and data throughout: +5
- Personal experience markers (I've found, In my experience): +5
- Good sentence rhythm (varied length, short punches): +5

PASS THRESHOLD: 70/100

Your response must be valid JSON matching this schema:
{
  "score": <number 0-100>,
  "passed": <boolean>,
  "issues": [
    {
      "code": "<CRITERIA_CODE>",
      "message": "<specific description of the issue>",
      "penalty": <negative number>,
      "location": "<where in the content, e.g., 'title', 'section:intro', 'faq:2'>",
      "suggestion": "<how to fix it>"
    }
  ],
  "bonuses": [
    {
      "code": "<CRITERIA_CODE>",
      "message": "<what they did well>",
      "bonus": <positive number>
    }
  ],
  "rewriteInstructions": "<detailed instructions for rewriting if failed, null if passed>"
}

Be SPECIFIC in your feedback. Don't just say "AI vocabulary found" - say WHICH words and WHERE.`,

    user: `PRIMARY KEYWORD: ${args.keyword}

CONTENT TO REVIEW:
${JSON.stringify(args.contentJson, null, 2)}

REVIEW THIS CONTENT:

1. Start with score = 100
2. Go through each penalty category and deduct points for violations
3. Add bonuses for positive signals
4. Calculate final score
5. If score < 70, provide detailed rewrite instructions

Be merciless. This content will represent our brand. If it sounds AI-generated, it fails.

Output valid JSON only. No markdown fences.`
  };
}

// JSON schema definition for the LLM to follow exactly
const BLOG_JSON_SCHEMA = `{
  "title": "string (no colons allowed)",
  "slug": "string",
  "meta": {
    "title": "string (50-60 chars)",
    "description": "string (150-160 chars)",
    "keywords": ["string array"]
  },
  "hero": {
    "hook": "string (opening hook)",
    "subtitle": "string"
  },
  "sections": [
    {
      "id": "string (unique like 'section-1')",
      "heading": "string (no colons)",
      "level": 2 or 3 (number, not string),
      "content": "string (under 150 words)",
      "keyTakeaway": "string or null",
      "cta": "string or null (include in 2-3 sections)"
    }
  ],
  "faq": [
    {
      "question": "string",
      "answer": "string (under 25 words)"
    }
  ],
  "conclusion": {
    "summary": "string",
    "cta": {
      "text": "string",
      "buttonText": "string",
      "action": "string (URL or action)"
    }
  },
  "internalLinks": ["string array of suggested internal link slugs"],
  "estimatedReadingMinutes": number
}`;

/**
 * Generate rewriter prompt based on review feedback
 */
export function rewriterPrompt(args: {
  contentJson: BlogPostStructure;
  keyword: string;
  reviewResult: ReviewResult;
  attemptNumber: number;
  learnedRules?: string;  // Rules learned from past failures
}) {
  const issuesList = args.reviewResult.issues
    .map(i => `- ${i.code}: ${i.message}${i.location ? ` (at ${i.location})` : ''}${i.suggestion ? ` → Fix: ${i.suggestion}` : ''}`)
    .join('\n');

  // Include learned rules section if available
  const learnedRulesSection = args.learnedRules ? `
${args.learnedRules}
` : '';

  return {
    system: `You are an expert editor fixing AI-generated content to be indistinguishable from human writing.

This is rewrite attempt ${args.attemptNumber} of 2. If this fails again, the content will be DELETED.

Your job is to fix ALL identified issues while maintaining the content's value and SEO optimization.
${learnedRulesSection}
CRITICAL: OUTPUT MUST MATCH THIS EXACT JSON STRUCTURE:
${BLOG_JSON_SCHEMA}

RULES:
1. Fix EVERY issue listed - don't skip any
2. Maintain the keyword focus: "${args.keyword}"
3. Keep the core information but AGGRESSIVELY cut words
4. Preserve ALL fields - don't remove or rename any keys
5. Keep "level" as number (2 or 3), not string
6. Keep "cta" and "keyTakeaway" as string or null, never undefined

CRITICAL WORD COUNT ENFORCEMENT:
- Each section content MUST be UNDER 150 words - COUNT THEM
- Each FAQ answer MUST be UNDER 25 words - COUNT THEM
- If currently over limit, DELETE sentences until under limit
- Better to be 100 words than 151 words

FORBIDDEN (instant rejection if found):
- "leverage", "paramount", "pivotal", "foster", "bolster", "robust", "delve"
- "arguably", "myriad", "plethora", "seamless", "cutting-edge"
- Colons in titles or headings
- "**Bold:** text" pattern
- "In today's...", "Let's dive...", "In this article...", "Let's explore..."
- "It's important to note", "It's worth mentioning"
- Hedge words: "potentially", "might be able to", "could possibly"

REQUIRED (must include):
- Contractions: don't, won't, it's, you'll, we've (use 5+ per section)
- Mid-article CTAs in 2-3 sections (put in the "cta" field)
- If title promises N items (e.g., "7 Mistakes"), have N numbered sections`,

    user: `CURRENT SCORE: ${args.reviewResult.score}/100 (need 70 to pass)
ATTEMPT: ${args.attemptNumber} of 2 - LAST CHANCE if attempt 2

ISSUES TO FIX (fix ALL or content will be DELETED):
${issuesList}

REWRITE INSTRUCTIONS FROM REVIEWER:
${args.reviewResult.rewriteInstructions || 'Fix all issues listed above.'}

WORD COUNT CHECKLIST BEFORE OUTPUTTING:
□ Each section under 150 words?
□ Each FAQ answer under 25 words?
□ No forbidden words?
□ 2-3 sections have CTAs?
□ Contractions used throughout?

CONTENT TO REWRITE:
${JSON.stringify(args.contentJson, null, 2)}

OUTPUT: Return ONLY the fixed JSON. Start with '{', end with '}'.
Keep the EXACT same structure - same keys, same types.
Fix ALL issues. Attempt ${args.attemptNumber} of 2.`
  };
}
