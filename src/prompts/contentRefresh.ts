import type { BlogPostStructure } from './blogGeneration.js';
import { getReadingLevelGuidelines } from './readingLevel.js';

export interface ContentRefreshArgs {
  currentPost: BlogPostStructure;
  keyword: string;
  refreshType: 'full_refresh' | 'ctr_optimize' | 'section_expand';
  gscContext: {
    topQueries?: Array<{ query: string; impressions: number; avgPosition: number }>;
    decline?: {
      baselinePosition: number;
      currentPosition: number;
      positionChange: number;
      clickDelta: number;
    };
    nearMissQuery?: string;
    nearMissImpressions?: number;
    ga4?: {
      sessions?: number;
      bounceRate?: number; // 0-1
      avgEngagementSec?: number;
    };
  };
}

/**
 * Prompt for CTR-only optimization: rewrites title and meta fields only.
 * Does not touch body content.
 */
export function ctrOptimizePrompt(args: {
  title: string;
  metaTitle: string;
  metaDescription: string;
  keyword: string;
  topQueries: string[];
  impressions: number;
  ctr: number;
  avgPosition: number;
}): { system: string; user: string } {
  return {
    system: `You are a conversion copywriter specializing in SEO title optimization.
Your job is to rewrite page titles and meta descriptions to dramatically increase click-through rate (CTR) in Google search results.

CORE PRINCIPLE: Match the searcher's exact language and create urgency without hype.

TITLE RULES:
- NO colons anywhere
- NO em dashes (—)
- Use simple, common words a non-native speaker would understand
- Use the searcher's own words from the "real queries" list below
- Include a specific number, dollar figure, or timeframe when possible
- Create a curiosity gap or state the outcome clearly
- Under 60 characters for meta title

META DESCRIPTION RULES:
- Under 155 characters
- Expand on the title's promise
- Include the primary keyword naturally
- End with a soft call to action if space allows
- NO colons or em dashes`,
    user: `CURRENT TITLE: "${args.title}"
CURRENT META TITLE: "${args.metaTitle}"
CURRENT META DESCRIPTION: "${args.metaDescription}"

PRIMARY KEYWORD: "${args.keyword}"
IMPRESSIONS/MONTH: ${args.impressions}
CURRENT CTR: ${(args.ctr * 100).toFixed(1)}%
CURRENT POSITION: ${args.avgPosition.toFixed(1)}

REAL QUERIES BRINGING PEOPLE TO THIS PAGE:
${args.topQueries.map((q, i) => `${i + 1}. "${q}"`).join('\n')}

These are the EXACT words real people searched. Your new title must feel like a direct answer to these queries.

TASK: Write 3 alternative title options and 2 alternative meta descriptions.
Then select the BEST one for each.

CRITICAL:
- Use words from the real queries list
- Create a specific promise or outcome
- No generic phrases like "everything you need to know"
- No colons, no em dashes

Return STRICT JSON:
{
  "title": "the best title option",
  "metaTitle": "the best meta title (under 60 chars)",
  "metaDescription": "the best meta description (under 155 chars)",
  "alternatives": {
    "titles": ["option 2", "option 3"],
    "descriptions": ["alternative description"]
  }
}`
  };
}

/**
 * Prompt for full content refresh: rewrites the full post with GSC context.
 * Goal is to capture near-miss queries and add freshness signals.
 */
export function fullRefreshPrompt(args: ContentRefreshArgs): { system: string; user: string } {
  const { currentPost, keyword, gscContext } = args;

  const declineSection = gscContext.decline
    ? `RANKING DECLINE DATA:
  - Baseline position: ${gscContext.decline.baselinePosition.toFixed(1)}
  - Current position: ${gscContext.decline.currentPosition.toFixed(1)}
  - Position change: +${gscContext.decline.positionChange.toFixed(1)} (worse)
  - Click delta: ${gscContext.decline.clickDelta} clicks/week

  LIKELY CAUSE: Google found fresher or more comprehensive content on the same topic.
  FIX: Add current-year freshness signals, strengthen thin sections, expand FAQ.`
    : '';

  const nearMissSection = gscContext.nearMissQuery
    ? `NEAR-MISS QUERY TO CAPTURE:
  "${gscContext.nearMissQuery}" — ${gscContext.nearMissImpressions ?? 0} impressions/month at position 5–20
  ADD a dedicated FAQ item or H3 section that directly answers this query.
  The section heading should contain the near-miss query's key words.`
    : '';

  const topQueriesSection = gscContext.topQueries && gscContext.topQueries.length > 0
    ? `REAL QUERIES ALREADY DRIVING TRAFFIC TO THIS PAGE:
${gscContext.topQueries.map(q => `  • "${q.query}" | ${q.impressions} impr | pos ${q.avgPosition.toFixed(1)}`).join('\n')}
  → Make sure the content clearly and directly answers these queries.
  → These queries should appear naturally in headings and FAQ items.`
    : '';

  const ga4Section = gscContext.ga4
    ? `GA4 ENGAGEMENT SIGNALS (Organic landing performance):
  - Sessions: ${gscContext.ga4.sessions ?? 0}
  - Bounce rate: ${gscContext.ga4.bounceRate != null ? `${Math.round(gscContext.ga4.bounceRate * 100)}%` : 'n/a'}
  - Avg engagement: ${gscContext.ga4.avgEngagementSec != null ? `${Math.round(gscContext.ga4.avgEngagementSec)}s` : 'n/a'}

  INTERPRETATION:
  - High bounce + low engagement usually means the opening fails to match intent fast.
  - Fix: strengthen the first 200 words, add an immediate "what you'll get" section, and align headings to the likely query intent.`
    : '';

  return {
    system: `You are an expert content refresher for B2B software consulting.
Your job is NOT to rewrite for style. The voice and tone are already correct.
Your job is to refresh this post to rank better and capture more search traffic.
${getReadingLevelGuidelines()}

REFRESH PRINCIPLES:
1. DEPTH FIRST: Every section must reach 200-300 words. Sections under 200 words are a Google quality failure — expand them with specific examples, real scenarios, and practical detail. This is the primary fix.
2. INFORMATION GAIN: Each section must add something not found in generic articles — a real number, a specific failure pattern, a counterintuitive insight, or a concrete step.
3. FRESHNESS: Add current-year context (2026). Replace outdated examples with recent ones.
4. QUERY ALIGNMENT: Add content that directly answers near-miss queries.
5. FAQ EXPANSION: Add 2-3 new FAQ items targeting specific queries from the real search data.

MINIMUM WORD COUNT: The refreshed post MUST be at least 1,800 words total. Google will not index posts below this threshold for competitive B2B topics.

PRESERVE EXACTLY:
- The post's voice, tone, and personality
- Existing CTAs and conversion elements
- The author's personal stories and project references
- The title (unless this is a CTR optimization)

DO NOT:
- Change the fundamental angle or message
- Add AI vocabulary (leverage, utilize, delve, etc.)
- Add colons to headings
- Remove existing content — only ADD or IMPROVE
- Change the slug`,
    user: `KEYWORD: "${keyword}"

${declineSection}

${nearMissSection}

${topQueriesSection}

${ga4Section}

CURRENT POST (refresh this):
${JSON.stringify(currentPost, null, 2)}

TASK:
${args.refreshType === 'full_refresh' ? `Do a FULL REFRESH:
1. Expand EVERY section under 200 words — add concrete examples, specific numbers, real failure patterns, and practical steps until each section is 200-300 words
2. Add 2-3 FAQ items targeting the near-miss and real queries above
3. Inject freshness signals (mention 2026, "as of this year", recent industry patterns)
4. Ensure the top real queries are answered explicitly somewhere in the content
5. Total post word count MUST be at least 1,800 words — this is non-negotiable for Google indexing` : ''}
${args.refreshType === 'section_expand' ? `SECTION EXPAND:
1. Add ONE new H3 section or FAQ item that directly answers the near-miss query: "${gscContext.nearMissQuery}"
2. The new section should be 150–200 words, specific, and practical
3. Place it logically within the existing structure` : ''}

Return the COMPLETE updated post as STRICT JSON matching the original schema exactly.
Only return the JSON — no commentary, no markdown fences.`
  };
}

/**
 * INDEX RESCUE — rewrite a post that Google REFUSED to index (Discovered/Crawled - currently
 * not indexed). Unlike full_refresh, this is allowed (required) to change the TITLE, because
 * clickbait/formulaic titles are a primary reason these pages are judged low-value.
 * Outputs the same BlogPostStructure JSON; the slug is preserved by the caller.
 */
export function indexRescuePrompt(args: {
  currentPost: BlogPostStructure;
  keyword: string;
  targetIcp?: string | null;
}): { system: string; user: string } {
  const { currentPost, keyword } = args;
  return {
    system: `You are rewriting a blog post that Google has REFUSED TO INDEX. It was judged
low-value, thin, or too similar to other pages. Your single job: make this page so genuinely
useful and specific that Google has no reason not to index it.
${getReadingLevelGuidelines()}
WHY GOOGLE REJECTED IT (fix all of these):
1. CLICKBAIT / VAGUE TITLE. Titles like "The Hidden Reason...", "...Bleeding Millions...",
   "...Unless You Fix This" signal low quality. REWRITE the title to be plain, specific, and
   matched to what a real person would search. State the actual topic and outcome. No hype,
   no colons, no em dashes, no "hidden/secret/shocking".
2. NO INFORMATION GAIN. Generic advice anyone could write. ADD real specifics: concrete
   numbers, a step-by-step method, a named trade-off, a contrarian but defensible opinion,
   and real first-hand framing ("In my experience...", "When I migrated..."). Never fabricate
   client names or fake case studies — use the author's own real project experience and
   general engineering knowledge.
3. THIN / DUPLICATE. Each section must add something a competitor article would not. Cut
   filler. Reach at least 1,500 words of genuine substance.

ALSO:
- Keep the author's first-person voice and any real CTAs.
- No AI vocabulary (leverage, utilize, delve, robust, seamless, etc.).
- No colons in the title or headings. No em dashes anywhere.
- Output the SAME JSON structure as the input post.`,
    user: `PRIMARY KEYWORD: "${keyword}"
${args.targetIcp ? `TARGET READER (ICP): ${args.targetIcp}\n` : ''}
CURRENT POST (Google refused to index this — rewrite it to be index-worthy):
${JSON.stringify(currentPost, null, 2)}

TASK:
1. Rewrite the TITLE to be specific and search-intent matched (no clickbait, no colon).
2. Rewrite/expand every section for real information gain — concrete numbers, steps, opinions,
   first-hand experience. Each section 200-300 words.
3. Add 2-3 FAQ items answering specific questions a buyer would actually search.
4. Total at least 1,500 words of genuine substance.
5. Keep the same JSON schema and keep it valid.

Return the COMPLETE rewritten post as STRICT JSON matching the input schema exactly.
Only return the JSON — no commentary, no markdown fences.`
  };
}
