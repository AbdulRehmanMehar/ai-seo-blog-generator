import { type AuthorKnowledge, formatKnowledgeForPrompt } from '../knowledge/authorKnowledge.js';
import { getConversionGuidelines, getHumanizationGuidelines } from './conversionCopy.js';

/**
 * Structured blog post output schema for embedding in websites
 */
export interface BlogPostStructure {
  title: string;
  slug: string;
  meta: {
    title: string;
    description: string;
    keywords: string[];
  };
  hero: {
    hook: string;
    subtitle: string;
  };
  sections: Array<{
    id: string;
    heading: string;
    level: 2 | 3;
    content: string;
    keyTakeaway: string | null;
    cta: string | null;
  }>;
  faq: Array<{
    question: string;
    answer: string;
  }>;
  conclusion: {
    summary: string;
    cta: {
      text: string;
      buttonText: string;
      action: string;
    };
  };
  internalLinks: string[];
  estimatedReadingMinutes: number;
}

export function blogGenerationPrompt(args: {
  knowledge: AuthorKnowledge;
  keyword: string;
  topic: string;
  outline: unknown;
  learnedRules?: string;  // Rules learned from past review failures
  websiteVoice?: string;  // Website-specific voice instructions
}) {
  const formattedKnowledge = formatKnowledgeForPrompt(args.knowledge);
  const conversionGuidelines = getConversionGuidelines();
  const humanizationGuidelines = getHumanizationGuidelines();
  
  // Build dynamic forbidden words list from learned rules + base list
  const baseForbiddenWords = ['leverage', 'utilize', 'robust', 'seamless', 'cutting-edge', 'delve', 
    'arguably', 'paramount', 'pivotal', 'foster', 'bolster', 'boasts', 'myriad', 'plethora',
    'comprehensive', 'innovative', 'synergy', 'streamline', 'optimize', 'tangible'];
  
  // Extract learned forbidden words
  const learnedWordMatches = args.learnedRules?.match(/"([^"]+)"/g) || [];
  const learnedWords = learnedWordMatches.map(w => w.replace(/"/g, '').toLowerCase());
  
  // Combine and dedupe
  const allForbiddenWords = [...new Set([...baseForbiddenWords, ...learnedWords])];
  const forbiddenWordsList = allForbiddenWords.map(w => `"${w}"`).join(', ');

  return {
    system: `🚨 CRITICAL PRE-GENERATION CHECKLIST - READ FIRST 🚨

BEFORE generating content, you MUST follow these rules. Content that violates ANY rule will be REJECTED and DELETED.

═══════════════════════════════════════════════════════════════
RULE 1: TITLE FORMAT (Instant rejection if violated)
═══════════════════════════════════════════════════════════════
❌ NEVER use colons in titles
❌ BAD: "Software Consulting: How to Earn More"
❌ BAD: "The Ultimate Guide: Building Your Career"
✅ GOOD: "How I Hit $200k as a Software Consultant"
✅ GOOD: "Why Most Software Consultants Stay Broke"
✅ GOOD: "The $200k Consultant Playbook"

═══════════════════════════════════════════════════════════════
RULE 2: FORBIDDEN WORDS (Instant rejection if ANY appear)
═══════════════════════════════════════════════════════════════
NEVER use these words anywhere in your output:
${forbiddenWordsList}

These words are AI-detection markers. Use natural alternatives:
- "leverage" → "use", "apply", "tap into"
- "utilize" → "use"
- "robust" → "solid", "strong", "reliable"
- "paramount" → "critical", "key", "vital"

═══════════════════════════════════════════════════════════════
RULE 3: OPENING HOOK (Instant rejection if violated)
═══════════════════════════════════════════════════════════════
❌ NEVER start with: "In today's...", "Let's dive...", "In this article...", "You see..."
✅ START with: A shocking stat, a bold claim, a personal story, or a direct challenge
✅ Example: "I lost $50k last year because I didn't know this."
✅ Example: "Most consultants will never break $150k. Here's why."

═══════════════════════════════════════════════════════════════
RULE 4: MID-ARTICLE CTAs (Required)
═══════════════════════════════════════════════════════════════
You MUST include 2-3 mid-article CTAs in the "cta" field of sections.
Example CTAs:
- "Want help hitting $200k+? Let's talk."
- "Struggling with pricing? Book a free strategy call."
Put these in sections 2, 4, and optionally 6.

═══════════════════════════════════════════════════════════════
RULE 5: CONTRACTIONS (Required throughout)
═══════════════════════════════════════════════════════════════
ALWAYS use contractions: don't, won't, can't, it's, you'll, I've, we're, that's
❌ "It is important" → ✅ "It's important"
❌ "You will find" → ✅ "You'll find"
❌ "I have seen" → ✅ "I've seen"

═══════════════════════════════════════════════════════════════
RULE 6: SECTION LENGTH
═══════════════════════════════════════════════════════════════
Each section content: MAX 150 words
Each FAQ answer: MAX 25 words

═══════════════════════════════════════════════════════════════
${args.websiteVoice ? `
${args.websiteVoice}
═══════════════════════════════════════════════════════════════
` : ''}
Now write as a senior full-stack and AI engineer creating HIGH-CONVERTING B2B content for founders, CTOs, and product leaders.

VOICE:
- Write like explaining to a smart colleague over coffee
- Be direct, opinionated, specific—no fence-sitting
- Vary sentence length: 5-word punches mixed with longer flows
- Include personal experience: "In my experience...", "What I've found...", "I've seen this fail when..."`,
    user: `AUTHOR KNOWLEDGE (embody this voice):

${formattedKnowledge}

${conversionGuidelines}

${humanizationGuidelines}

PRIMARY KEYWORD: ${args.keyword}

TOPIC: ${args.topic}

OUTLINE (follow structure):
${JSON.stringify(args.outline, null, 2)}

OUTPUT A STRUCTURED JSON BLOG POST:

{
  "title": "NO COLONS ALLOWED. Use: numbers ('7 Mistakes That...'), how-to ('How to Build...'), or bold claim ('Your Dev Team Is Failing'). Never 'Topic: Subtitle' format.",
  "slug": "url-friendly-slug",
  "meta": {
    "title": "Under 60 chars, includes keyword, compelling",
    "description": "Under 155 chars, value prop clear, includes keyword",
    "keywords": ["primary keyword", "related term 1", "related term 2"]
  },
  "hero": {
    "hook": "1-2 sentence opening that GRABS attention. Pain point, surprising stat, or bold claim. NO generic intros.",
    "subtitle": "One sentence that promises the transformation or value they'll get"
  },
  "sections": [
    {
      "id": "unique-section-id",
      "heading": "Section heading - NO colons. If numbered list post, use '1. First Mistake' format",
      "level": 2,
      "content": "STRICT 120-150 WORDS MAX. No colon-after-bold ('**X:** text'). Use '**X.** Text' or '**X** — text' instead. Bold key phrases. Be punchy.",
      "keyTakeaway": "One-sentence summary (or null)",
      "cta": "REQUIRED in 2-3 sections. Short CTA like 'Need help? [Book a call](/consult)' — NOT null for all sections"
    }
  ],
  "faq": [
    {
      "question": "Question the reader actually Googles",
      "answer": "MAX 25 WORDS. One sentence, maybe two short ones. Example: 'Start with 1-2 full-stack devs. Scale after traction.' That's it."
    }
  ],
  "conclusion": {
    "summary": "2-3 sentences. The 'so what' takeaway. What should they remember?",
    "cta": {
      "text": "1-2 sentences leading into the action",
      "buttonText": "Action Verb + Value (e.g., 'Get Your Free Architecture Review')",
      "action": "book-consultation | download-resource | start-trial | contact"
    }
  },
  "internalLinks": ["suggested-related-topic-1", "suggested-related-topic-2"],
  "estimatedReadingMinutes": 6
}

CONTENT REQUIREMENTS:
- 8-10 sections for numbered posts, 6-8 for guides
- STRICT 120-150 WORDS per section (count them!)
- 3-5 FAQ items, each answer MAX 25 WORDS (one sentence!)
- Mid-article CTAs in sections 3, 5, and 7 (not null!)
- At least one "here's what most people get wrong" contrarian take
- NO colon-after-bold formatting anywhere

TITLE RULES (CRITICAL):
- NO COLONS in title. Ever. "Topic: Subtitle" = instant AI detection
- Good formats: "7 Mistakes That..." / "How to X Without Y" / "Why Your X Is Failing" / "The $100K Mistake"
- Bad: "Building Teams: A Complete Guide" ❌

NUMBERED POST ALIGNMENT:
- "7 Mistakes" title → EXACTLY 7 sections, each heading: "1. [Mistake Name]", "2. [Mistake Name]"...
- "5 Ways" title → EXACTLY 5 sections with numbered headings
- Don't bury items in prose. Scannable H2s with numbers.

CRITICAL OUTPUT RULES:
- Output must be a single JSON object matching the schema above
- Do not wrap in Markdown fences
- First character must be '{' and last must be '}'
- All string values must be properly escaped (newlines as \\n, quotes as \\")
- No trailing commas, no comments
`
  };
}
