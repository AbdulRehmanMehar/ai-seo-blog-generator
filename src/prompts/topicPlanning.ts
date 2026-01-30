import { type AuthorKnowledge, formatKnowledgeForPrompt } from '../knowledge/authorKnowledge.js';
import { getHeadlineGuidelines } from './conversionCopy.js';

export function topicPlanningPrompt(args: {
  knowledge: AuthorKnowledge;
  candidateKeywords: Array<{ keyword: string; volume: number | null; difficulty: number | null; cpc: number | null; intent: string | null }>;
  selectCount: number;
  targetWebsite?: string;
  existingPosts?: Array<{ title: string; keyword: string }>;
}) {
  const formattedKnowledge = formatKnowledgeForPrompt(args.knowledge);
  const headlineGuidelines = getHeadlineGuidelines();
  
  // Build existing posts section if we have any
  let existingPostsSection = '';
  if (args.existingPosts && args.existingPosts.length > 0) {
    const postsList = args.existingPosts
      .map(p => `- "${p.title}" (keyword: ${p.keyword})`)
      .join('\n');
    existingPostsSection = `

⚠️ EXISTING CONTENT FOR ${args.targetWebsite?.toUpperCase() || 'THIS WEBSITE'} - DO NOT DUPLICATE:
The following posts already exist. You MUST create DIFFERENT angles, perspectives, or focus areas.
If reusing a keyword, take a completely fresh approach (different audience, different problem, different solution angle).

${postsList}

EXAMPLES OF GOOD DIFFERENTIATION:
- Existing: "How to Hire a CTO" → New: "5 Signs You Need a Fractional CTO Instead of Full-Time"
- Existing: "MVP Development Cost" → New: "Why Your MVP Budget Is Wrong and How to Fix It"
- Existing: "Software Development Team" → New: "Remote vs In-House Dev Teams - What Founders Get Wrong"
`;
  }

  return {
    system: `You are a senior software consulting content strategist who writes high-converting B2B content. 
Your topics must be specific, outcome-focused, and use proven headline formulas that drive clicks and conversions.
Avoid generic, hype-filled, or overly broad topics. Every topic must have a clear pain point or transformation.

CRITICAL: Never use colons in headlines or titles. Write naturally flowing titles without colons or em dashes.
CRITICAL: If given existing posts, you MUST create completely different content angles - never repeat similar topics.`,
    user: `AUTHOR KNOWLEDGE (must reflect in output):

${formattedKnowledge}

${headlineGuidelines}${existingPostsSection}

CANDIDATE KEYWORDS to pick ${args.selectCount} from:
${JSON.stringify(args.candidateKeywords, null, 2)}

TASK:
- Choose ${args.selectCount} keywords with the highest commercial plus founder or CTO intent.
- For each, create a headline using ONE of the headline formulas being Numbers, How-To, Curiosity Gap, Direct Benefit, or Contrarian.
- CRITICAL: No colons in headlines. Write flowing titles like \"How to Build a Dev Team That Ships\" not \"Building Teams. A Complete Guide\"
- Outline MUST start with a HOOK section, not definitions or intros.
- Include a \"Common Mistakes\" or \"What Most Get Wrong\" section.
- End outline with actionable next steps section.

OUTPUT STRICT JSON ONLY with shape:
{
  "selected": [
    {
      "keyword": string,
      "topic": string that is the full headline with no colons,
      "headline_formula_used": string,
      "outline": [ { "heading": string with no colons, "level": 2 or 3, "notes": string } ]
    }
  ]
}

CRITICAL OUTPUT RULES:
- Output must be a single JSON object not an array.
- Do not wrap the JSON in Markdown fences.
- The first character must be curly brace and the last character must be curly brace.
- No trailing commas, no comments, no extra keys.
- No colons in any headline or heading text.
`
  };
}
