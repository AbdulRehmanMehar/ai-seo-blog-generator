import { type AuthorKnowledge, formatKnowledgeForPrompt } from '../knowledge/authorKnowledge.js';
import { getHeadlineGuidelines } from './conversionCopy.js';

export function topicPlanningPrompt(args: {
  knowledge: AuthorKnowledge;
  candidateKeywords: Array<{ keyword: string; volume: number | null; difficulty: number | null; cpc: number | null; intent: string | null }>;
  selectCount: number;
}) {
  const formattedKnowledge = formatKnowledgeForPrompt(args.knowledge);
  const headlineGuidelines = getHeadlineGuidelines();
  return {
    system: `You are a senior software consulting content strategist who writes high-converting B2B content. 
Your topics must be specific, outcome-focused, and use proven headline formulas that drive clicks and conversions.
Avoid generic, hype-filled, or overly broad topics. Every topic must have a clear pain point or transformation.`,
    user: `AUTHOR KNOWLEDGE (must reflect in output):

${formattedKnowledge}

${headlineGuidelines}

CANDIDATE KEYWORDS (pick ${args.selectCount}):
${JSON.stringify(args.candidateKeywords, null, 2)}

TASK:
- Choose ${args.selectCount} keywords with the highest commercial + founder/CTO intent.
- For each, create a headline using ONE of the headline formulas (Numbers, How-To, Curiosity Gap, Direct Benefit, or Contrarian).
- Outline MUST start with a HOOK section (not definitions or intros).
- Include a "Common Mistakes" or "What Most Get Wrong" section.
- End outline with actionable next steps section.

OUTPUT STRICT JSON ONLY with shape:
{
  "selected": [
    {
      "keyword": string,
      "topic": string,
      "headline_formula_used": string,
      "outline": [ { "heading": string, "level": 2|3, "notes": string } ]
    }
  ]
}

CRITICAL OUTPUT RULES:
- Output must be a single JSON object (not an array).
- Do not wrap the JSON in Markdown fences.
- The first character must be '{' and the last character must be '}'.
- No trailing commas, no comments, no extra keys.
`
  };
}
