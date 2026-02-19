import { type AuthorKnowledge, formatKnowledgeForPrompt } from '../knowledge/authorKnowledge.js';
import { type IcpPersona, formatIcpForPrompt } from '../knowledge/icpKnowledge.js';
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
  /** ICP persona to write for. Activates "That's Me" framework from ContentWriting playbook. */
  targetIcp?: IcpPersona;
}) {
  const formattedKnowledge = formatKnowledgeForPrompt(args.knowledge);
  const conversionGuidelines = getConversionGuidelines();
  const humanizationGuidelines = getHumanizationGuidelines();

  // Build ICP section if we have a persona
  const icpSection = args.targetIcp
    ? `${formatIcpForPrompt(args.targetIcp)}`
    : '';
  
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
    system: `CRITICAL PRE-GENERATION CHECKLIST - READ FIRST

BEFORE generating content, you MUST follow these rules. Content that violates ANY rule will be REJECTED and DELETED.

RULE 0: NO FABRICATION (Instant rejection if violated)

NEVER make up:
- Client stories or customer testimonials
- Company names you "helped" or "worked with"
- Specific results for unnamed clients ("I helped a startup increase revenue by 50%")
- Case studies that don't exist

ONLY reference:
- Your own direct experience from real projects (SmashCloud, DashCam.io, etc.)
- General technical knowledge and best practices
- Educational examples that don't claim to be real clients

Good: "In my experience building production APIs..."
Good: "When I migrated the SmashCloud platform..."
Bad: "I helped a client reduce costs by 60%..." (fabrication)
Bad: "My clients consistently see..." (fabrication)

RULE 1: FORMATTING RESTRICTIONS (Instant rejection if violated)

NEVER use these characters or patterns anywhere in your output:
- Colons (:) anywhere in titles, headings, or body text
- Em dashes (—) anywhere
- Markdown syntax like hashtags (#), asterisks (*), underscores for formatting
- Bold markers (**text**)
- Bullet point symbols

BAD examples:
- "Software Consulting: How to Earn More" (has colon)
- "This is key — you need to act fast" (has em dash)
- "**Important point:** here is why" (has markdown and colon)

GOOD examples:
- "How I Hit $200k as a Software Consultant"
- "Why Most Software Consultants Stay Broke"
- "The $200k Consultant Playbook"
- "This is key and you need to act fast"
- "Important point. Here is why."

RULE 2: FORBIDDEN WORDS (Instant rejection if ANY appear)

NEVER use these words anywhere in your output:
${forbiddenWordsList}

These words are AI-detection markers. Use natural alternatives:
- "leverage" becomes "use", "apply", "tap into"
- "utilize" becomes "use"
- "robust" becomes "solid", "strong", "reliable"
- "paramount" becomes "critical", "key", "vital"

RULE 3: OPENING HOOK (Instant rejection if violated)

NEVER start with: "In today's...", "Let's dive...", "In this article...", "You see..."${args.targetIcp ? `
TARGET READER for this post: ${args.targetIcp.persona_name} (${args.targetIcp.biographics.title})
The hook MUST make them say "that's me" in the first 2 sentences.
Their stuck scenario: "${args.targetIcp.the_crap_he_deals_with}"
Their deepest fear: "${args.targetIcp.psychographics.fears}"
Use the EMPATHY-BASED HOOK formula from the TARGET READER PROFILE below.` : ''}
START with: A shocking stat, a bold claim, a personal story, or a direct challenge${args.targetIcp ? ` ROOTED IN THE TARGET READER'S REALITY` : ''}
Example: "I lost $50k last year because I didn't know this."
Example: "Most consultants will never break $150k. Here is why."

RULE 4: MID-ARTICLE CTAs (Required)

You MUST include 2-3 mid-article CTAs in the "cta" field of sections.
Example CTAs:
- "Want help hitting $200k+? Let us talk."
- "Struggling with pricing? Book a free strategy call."
Put these in sections 2, 4, and optionally 6.

RULE 5: CONTRACTIONS (Required throughout)

ALWAYS use contractions: don't, won't, can't, it's, you'll, I've, we're, that's
- "It is important" becomes "It's important"
- "You will find" becomes "You'll find"
- "I have seen" becomes "I've seen"

RULE 6: SECTION LENGTH

Each section content: MAX 150 words
Each FAQ answer: MAX 25 words

RULE 7: PLAIN TEXT ONLY

All content must be plain text without any formatting characters.
No colons, no em dashes, no asterisks, no hashtags.
Use periods and commas for punctuation.
Use "and" or "but" instead of dashes for contrast.
Write complete sentences that flow naturally when read aloud.

RULE 8: SELL MONEY, NOT SERVICES (Required in every post)

Your reader doesn't want a developer. They want revenue, risk reduction, or time they can't get back.
Every post MUST include:

1. AT LEAST ONE cost-of-inaction statement.
   Frame it as: "Every [time unit] you don't solve [problem] costs [dollar amount or specific loss]."
   This makes the reader feel the pain of doing nothing. Without this, there is no urgency.
   ${args.targetIcp ? `For ${args.targetIcp.persona_name} specifically: ${args.targetIcp.cost_of_inaction}` : 'Derive a realistic dollar figure from the business context of the topic.'}

2. AT LEAST ONE dollarized value statement.
   Run every benefit through: [Your Work] → [Specific Outcome] → [Dollar Value]
   Bad: "Improves performance."
   Good: "Cuts API response time from 800ms to 120ms, which on a 50k/day user base prevents roughly $40k/month in abandoned sessions."
   ${args.targetIcp ? `Their spending logic confirms this framing works: "${args.targetIcp.psychographics.spending_logic}"` : ''}

3. TOPIC MUST BE A BUSINESS PROBLEM, NOT A SERVICE.
   The headline targets a business outcome. Your deliverable is the answer inside the content.
   Never write "how to build X." Write "why your Y is failing" where X is the answer.

${args.websiteVoice ? `
${args.websiteVoice}
` : ''}
Now write as a senior full-stack and AI engineer creating HIGH-CONVERTING B2B content for founders, CTOs, and product leaders.

VOICE:
- Write like explaining to a smart colleague over coffee
- Be direct, opinionated, specific without fence-sitting
- Vary sentence length with 5-word punches mixed with longer flows
- Include personal experience like "In my experience" or "What I've found" or "I've seen this fail when"${args.targetIcp ? `

ICP-SPECIFIC VOICE CALIBRATION for ${args.targetIcp.persona_name}:
- This reader is a ${args.targetIcp.biographics.title}. Write at their level.
- They value: ${args.targetIcp.psychographics.values}
- Do NOT talk down to them. They've seen every vendor pitch.
- Their spending logic: ${args.targetIcp.psychographics.spending_logic}
- Address their fear proactively in at least one section: "${args.targetIcp.psychographics.fears}"
- CTAs must promise their transformation: "${args.targetIcp.the_hunger}"` : ''}`,
    user: `AUTHOR KNOWLEDGE (embody this voice):

${formattedKnowledge}
${icpSection}
${conversionGuidelines}

${humanizationGuidelines}

PRIMARY KEYWORD: ${args.keyword}

TOPIC: ${args.topic}

OUTLINE (follow structure):
${JSON.stringify(args.outline, null, 2)}

OUTPUT A STRUCTURED JSON BLOG POST:

{
  "title": "NO COLONS OR EM DASHES ALLOWED. Use numbers like 7 Mistakes That or how-to like How to Build or bold claim like Your Dev Team Is Failing. Never use Topic Subtitle format with colons.",
  "slug": "url-friendly-slug",
  "meta": {
    "title": "Under 60 chars, includes keyword, compelling, no colons",
    "description": "Under 155 chars, value prop clear, includes keyword, no colons or em dashes",
    "keywords": ["primary keyword", "related term 1", "related term 2"]
  },
  "hero": {
    "hook": "1-2 sentence opening that GRABS attention. Pain point, surprising stat, or bold claim. NO generic intros. NO colons or em dashes.",
    "subtitle": "One sentence that promises the transformation or value they will get. Plain text only."
  },
  "sections": [
    {
      "id": "unique-section-id",
      "heading": "Section heading with NO colons or dashes. If numbered list post use format like 1. First Mistake",
      "level": 2,
      "content": "STRICT 120-150 WORDS MAX. Plain text only. No colons, no em dashes, no markdown formatting. Write naturally flowing sentences. Be punchy.",
      "keyTakeaway": "One-sentence summary or null. Plain text.",
      "cta": "REQUIRED in 2-3 sections. Short CTA like Need help then book a call. NOT null for all sections"
    }
  ],
  "faq": [
    {
      "question": "Question the reader actually Googles. No colons.",
      "answer": "MAX 25 WORDS. One sentence, maybe two short ones. Example is Start with 1-2 full-stack devs. Scale after traction."
    }
  ],
  "conclusion": {
    "summary": "2-3 sentences. The so what takeaway. What should they remember. Plain text.",
    "cta": {
      "text": "1-2 sentences leading into the action. No colons.",
      "buttonText": "Action Verb plus Value like Get Your Free Architecture Review",
      "action": "book-consultation or download-resource or start-trial or contact"
    }
  },
  "internalLinks": ["suggested-related-topic-1", "suggested-related-topic-2"],
  "estimatedReadingMinutes": 6
}

CONTENT REQUIREMENTS:
- 8-10 sections for numbered posts, 6-8 for guides
- STRICT 120-150 WORDS per section (count them)
- 3-5 FAQ items, each answer MAX 25 WORDS (one sentence)
- Mid-article CTAs in sections 3, 5, and 7 (not null)${args.targetIcp ? `
- CTAs must speak to ${args.targetIcp.persona_name}'s hunger: "${args.targetIcp.the_hunger.substring(0, 80)}..."
- Address their fear in at least one section: "${args.targetIcp.psychographics.fears.substring(0, 80)}..."` : ''}
- REQUIRED: at least one "cost of inaction" statement with a specific dollar figure or business consequence${args.targetIcp ? ` (context: ${args.targetIcp.cost_of_inaction.substring(0, 120)}...)` : ''}
- REQUIRED: at least one dollarized value statement ([Your Work] → [Outcome] → [Dollar Value])
- At least one contrarian take about what most people get wrong
- PLAIN TEXT ONLY throughout. No colons, no em dashes, no markdown formatting
- Write naturally flowing sentences that sound human when read aloud
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
