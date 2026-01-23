import type { BlogPostStructure } from './blogGeneration.js';

/**
 * Review criteria with scoring weights
 */
export const REVIEW_CRITERIA = {
  // Instant fails (heavy penalties)
  AI_VOCABULARY: { weight: -10, description: 'AI vocabulary found like delve, leverage, arguably, paramount, etc.' },
  COLON_IN_TITLE: { weight: -25, description: 'Colon in title which is an AI pattern' },
  COLON_IN_CONTENT: { weight: -15, description: 'Colon found in body text' },
  EM_DASH_IN_CONTENT: { weight: -15, description: 'Em dash found in content' },
  MARKDOWN_IN_CONTENT: { weight: -15, description: 'Markdown formatting found like asterisks or hashtags' },
  FORBIDDEN_OPENING: { weight: -20, description: 'Forbidden opening pattern like In todays or Lets dive' },
  
  // Structural issues
  FAQ_TOO_LONG: { weight: -5, description: 'FAQ answer over 25 words' },
  SECTION_TOO_LONG: { weight: -5, description: 'Section over 150 words' },
  MISSING_MID_CTAS: { weight: -15, description: 'Missing mid-article CTAs' },
  TITLE_CONTENT_MISMATCH: { weight: -20, description: 'Title promises number but content does not deliver' },
  
  // Voice and tone issues
  NO_CONTRARIAN_TAKE: { weight: -10, description: 'No contrarian or surprising take' },
  WEAK_HOOK: { weight: -15, description: 'Opening hook does not grab attention' },
  TOO_FORMAL: { weight: -10, description: 'Missing contractions, too formal tone' },
  
  // Positive signals (bonuses)
  SPECIFIC_NUMBERS: { weight: 5, description: 'Uses specific numbers and data' },
  PERSONAL_EXPERIENCE: { weight: 5, description: 'Includes personal experience markers' },
  GOOD_SENTENCE_RHYTHM: { weight: 5, description: 'Varied sentence length, includes short punches' },
  PLAIN_TEXT_FORMAT: { weight: 5, description: 'Content is clean plain text without formatting characters' },
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

You have ZERO tolerance for AI patterns. If content sounds like it was written by ChatGPT, Claude, or Gemini, it FAILS.

SCORING SYSTEM (start at 100, deduct penalties)

INSTANT PENALTIES:
- AI vocabulary found gets -10 PER INSTANCE for words like delve, leverage, arguably, paramount, pivotal, foster, bolster, boasts, myriad, plethora, etc.
- Colon in title gets -25 because patterns like "Topic. A Guide" are instant AI detection
- Colon anywhere in body text gets -15 per instance
- Em dash anywhere in content gets -15 per instance
- Markdown formatting like asterisks or hashtags gets -15
- Forbidden opening patterns get -20 for phrases like "In today's" or "Let's dive"

STRUCTURAL PENALTIES:
- FAQ answer over 25 words gets -5 per instance
- Section over 150 words gets -5 per instance  
- Missing mid-article CTAs which should have 2-3 gets -15
- Title promises number but content does not deliver gets -20

VOICE AND TONE PENALTIES:
- No contrarian or surprising take gets -10
- Weak opening hook that does not grab attention gets -15
- Too formal with missing contractions or stiff tone gets -10

BONUSES:
- Specific numbers and data throughout gets +5
- Personal experience markers like "I've found" or "In my experience" gets +5
- Good sentence rhythm with varied length and short punches gets +5
- Clean plain text without formatting characters gets +5

PASS THRESHOLD is 70 out of 100

Your response must be valid JSON matching this schema:
{
  "score": number 0-100,
  "passed": boolean,
  "issues": [
    {
      "code": "CRITERIA_CODE",
      "message": "specific description of the issue",
      "penalty": negative number,
      "location": "where in the content, like title, section intro, faq 2",
      "suggestion": "how to fix it"
    }
  ],
  "bonuses": [
    {
      "code": "CRITERIA_CODE",
      "message": "what they did well",
      "bonus": positive number
    }
  ],
  "rewriteInstructions": "detailed instructions for rewriting if failed, null if passed"
}

Be SPECIFIC in your feedback. Don't just say "AI vocabulary found" but say WHICH words and WHERE.
Also check that there are NO colons, NO em dashes, and NO markdown formatting anywhere.`,

    user: `PRIMARY KEYWORD is ${args.keyword}

CONTENT TO REVIEW:
${JSON.stringify(args.contentJson, null, 2)}

REVIEW THIS CONTENT:

1. Start with score = 100
2. Go through each penalty category and deduct points for violations
3. Check specifically for colons, em dashes, and markdown formatting
4. Add bonuses for positive signals
5. Calculate final score
6. If score is below 70, provide detailed rewrite instructions

Be merciless. This content will represent our brand. If it sounds AI-generated, it fails.
If it contains colons, em dashes, or markdown, it fails.

Output valid JSON only. No markdown fences.`
  };
}

// JSON schema definition for the LLM to follow exactly
const BLOG_JSON_SCHEMA = `{
  "title": "string with no colons or em dashes allowed",
  "slug": "string",
  "meta": {
    "title": "string 50-60 chars with no colons",
    "description": "string 150-160 chars with no colons",
    "keywords": ["string array"]
  },
  "hero": {
    "hook": "string opening hook with no colons or em dashes",
    "subtitle": "string with no colons"
  },
  "sections": [
    {
      "id": "string unique like section-1",
      "heading": "string with no colons or em dashes",
      "level": 2 or 3 as number not string,
      "content": "string under 150 words with no colons or markdown",
      "keyTakeaway": "string or null",
      "cta": "string or null and include in 2-3 sections"
    }
  ],
  "faq": [
    {
      "question": "string with no colons",
      "answer": "string under 25 words with no colons or em dashes"
    }
  ],
  "conclusion": {
    "summary": "string with no colons or em dashes",
    "cta": {
      "text": "string with no colons",
      "buttonText": "string with no colons",
      "action": "string URL or action"
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
    .map(i => `- ${i.code} for ${i.message}${i.location ? ` at ${i.location}` : ''}${i.suggestion ? `. Fix by ${i.suggestion}` : ''}`)
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
CRITICAL OUTPUT MUST MATCH THIS EXACT JSON STRUCTURE:
${BLOG_JSON_SCHEMA}

RULES:
1. Fix EVERY issue listed and don't skip any
2. Maintain the keyword focus which is \"${args.keyword}\"
3. Keep the core information but AGGRESSIVELY cut words
4. Preserve ALL fields and don't remove or rename any keys
5. Keep \"level\" as number 2 or 3, not string
6. Keep \"cta\" and \"keyTakeaway\" as string or null, never undefined

CRITICAL FORMATTING RULES:
- Remove ALL colons from titles, headings, and body text
- Remove ALL em dashes and replace with commas, periods, or the word \"and\"
- Remove ALL markdown formatting like asterisks and hashtags
- Output must be plain natural-sounding text only

CRITICAL WORD COUNT ENFORCEMENT:
- Each section content MUST be UNDER 150 words so COUNT THEM
- Each FAQ answer MUST be UNDER 25 words so COUNT THEM
- If currently over limit, DELETE sentences until under limit
- Better to be 100 words than 151 words

FORBIDDEN (instant rejection if found):
- \"leverage\", \"paramount\", \"pivotal\", \"foster\", \"bolster\", \"robust\", \"delve\"
- \"arguably\", \"myriad\", \"plethora\", \"seamless\", \"cutting-edge\"
- Colons anywhere in titles, headings, or body text
- Em dashes anywhere in the content
- Markdown formatting like asterisks or hashtags
- \"In today's\", \"Let's dive\", \"In this article\", \"Let's explore\"
- \"It's important to note\", \"It's worth mentioning\"
- Hedge words like \"potentially\", \"might be able to\", \"could possibly\"

REQUIRED (must include):
- Contractions like don't, won't, it's, you'll, we've with 5+ per section
- Mid-article CTAs in 2-3 sections put in the \"cta\" field
- If title promises N items like \"7 Mistakes\", have N numbered sections
- Plain text only with no special formatting characters`,

    user: `CURRENT SCORE is ${args.reviewResult.score} out of 100 and need 70 to pass
ATTEMPT ${args.attemptNumber} of 2. LAST CHANCE if attempt 2

ISSUES TO FIX and fix ALL or content will be DELETED:
${issuesList}

REWRITE INSTRUCTIONS FROM REVIEWER:
${args.reviewResult.rewriteInstructions || 'Fix all issues listed above.'}

CHECKLIST BEFORE OUTPUTTING:
- Each section under 150 words
- Each FAQ answer under 25 words
- No forbidden words
- No colons anywhere
- No em dashes anywhere
- No markdown formatting
- 2-3 sections have CTAs
- Contractions used throughout

CONTENT TO REWRITE:
${JSON.stringify(args.contentJson, null, 2)}

OUTPUT: Return ONLY the fixed JSON. Start with curly brace, end with curly brace.
Keep the EXACT same structure with same keys and same types.
Fix ALL issues. Attempt ${args.attemptNumber} of 2.
All text must be plain natural prose without colons, em dashes, or markdown.`
  };
}
