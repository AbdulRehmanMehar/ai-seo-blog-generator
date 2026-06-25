/**
 * Prompts for content taxonomy:
 *  1. classify a post into controlled categories + open tags
 *  2. generate unique SEO content for a category/tag hub page
 */

import { getReadingLevelGuidelines } from './readingLevel.js';

export interface CategoryOption {
  name: string;
  description: string | null;
}

const FORBIDDEN_WORDS = [
  'leverage', 'utilize', 'robust', 'seamless', 'cutting-edge', 'delve', 'paramount',
  'pivotal', 'foster', 'bolster', 'myriad', 'plethora', 'comprehensive', 'innovative',
  'synergy', 'streamline', 'tangible'
];

/**
 * Ask the model to assign a post to 1–3 of the EXISTING categories (never invent new
 * ones) plus 3–6 normalized tags.
 */
export function taxonomyClassificationPrompt(args: {
  title: string;
  keyword: string;
  summary: string;
  targetIcp?: string | null;
  categories: CategoryOption[];
  maxCategories: number;
  maxTags: number;
}) {
  const categoryList = args.categories
    .map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''}`)
    .join('\n');

  const system = `You are a content taxonomist for a B2B software consulting blog.
Your job is to file a blog post under the correct categories and tags so readers and
search engines can navigate topic clusters.

HARD RULES:
- Categories MUST be chosen ONLY from the provided list. Never invent a category.
- Pick the FEWEST categories that genuinely fit (1 is ideal, ${args.maxCategories} is the max). The first one you return is the PRIMARY category.
- Tags are short topical labels (1–3 words), lowercase, specific (e.g. "nextjs migration", "hipaa", "fractional cto"). Return ${args.maxTags} at most. No duplicates, no the category names verbatim, no generic filler like "software" or "technology".
- Return ONLY valid JSON, no markdown fences.`;

  const user = `POST TO CLASSIFY
Title: ${args.title}
Primary keyword: ${args.keyword}
${args.targetIcp ? `Target reader (ICP): ${args.targetIcp}\n` : ''}Summary: ${args.summary}

AVAILABLE CATEGORIES (choose from these names EXACTLY):
${categoryList}

Return JSON:
{"categories": ["Primary Category Name", "Optional Second"], "tags": ["tag one", "tag two", "tag three"]}`;

  return { system, user };
}

/**
 * Generate unique overview content for a category or tag hub page, grounded in the
 * actual posts filed under it (so it is genuinely unique, not boilerplate).
 */
export function taxonomyPageContentPrompt(args: {
  type: 'category' | 'tag';
  name: string;
  description?: string | null;
  websiteDomain: string;
  brandName?: string | null;
  voiceInstructions?: string;
  posts: Array<{ title: string; keyword: string }>;
}) {
  const postList = args.posts
    .slice(0, 25)
    .map((p) => `- ${p.title} (targets: ${p.keyword})`)
    .join('\n');

  const label = args.type === 'category' ? 'category' : 'tag';

  const system = `You write unique, genuinely useful overview content for ${label} hub pages on a B2B software consulting blog (${args.brandName ?? args.websiteDomain}).
${getReadingLevelGuidelines()}
The page lists every article in this ${label}. Your text is the intro/overview a human and a search engine read BEFORE the article list. It must add real value, not restate the title.

RULES:
- 350–600 words of original prose. No fabricated clients, stats, or case studies.
- Frame the ${label} around the reader's real problem and what they will learn by reading the articles here.
- Plain prose only. No colons in the title or meta_title. No em dashes. No markdown headers, bold, or bullet symbols.
- Do not use these AI-tell words: ${FORBIDDEN_WORDS.join(', ')}.
- Write in the brand voice if provided.
- Return ONLY valid JSON, no markdown fences.
${args.voiceInstructions ? `\nBRAND VOICE:\n${args.voiceInstructions}\n` : ''}`;

  const user = `${args.type === 'category' ? 'CATEGORY' : 'TAG'}: ${args.name}
${args.description ? `Short description: ${args.description}\n` : ''}
ARTICLES CURRENTLY FILED UNDER THIS ${label.toUpperCase()}:
${postList || '(no articles yet)'}

Write the hub-page overview. Return JSON:
{
  "seo_content": "350-600 words of original overview prose",
  "meta_title": "under 60 chars, no colon",
  "meta_description": "under 155 chars, compelling summary"
}`;

  return { system, user };
}
