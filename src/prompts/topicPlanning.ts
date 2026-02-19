import { type AuthorKnowledge, formatKnowledgeForPrompt } from '../knowledge/authorKnowledge.js';
import { type IcpPersona, formatIcpForPrompt } from '../knowledge/icpKnowledge.js';
import { getHeadlineGuidelines } from './conversionCopy.js';

export function topicPlanningPrompt(args: {
  knowledge: AuthorKnowledge;
  candidateKeywords: Array<{ keyword: string; volume: number | null; difficulty: number | null; cpc: number | null; intent: string | null }>;
  selectCount: number;
  targetWebsite?: string;
  existingPosts?: Array<{ title: string; keyword: string }>;
  /** ICP persona to target. When provided, topics will be designed to attract this specific person. */
  targetIcp?: IcpPersona;
}) {
  const formattedKnowledge = formatKnowledgeForPrompt(args.knowledge);
  const headlineGuidelines = getHeadlineGuidelines();

  // Build ICP section if we have a persona
  const icpSection = args.targetIcp
    ? `\n${formatIcpForPrompt(args.targetIcp)}\n`
    : '';
  
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
CRITICAL: If given existing posts, you MUST create completely different content angles - never repeat similar topics.
CRITICAL: Target BUSINESS PROBLEMS, not services. The client's deliverable is the answer inside the post, never the topic itself.
CRITICAL: "Size of problem = size of budget." Pick problems that high-budget clients feel urgently. Generic small-business problems attract broke clients.${args.targetIcp ? `\nCRITICAL: Every topic MUST be designed so "${args.targetIcp.persona_name}" reads the headline and immediately thinks "that's me." The pain point, language, and outcome must resonate with their profile.` : ''}`,
    user: `AUTHOR KNOWLEDGE (must reflect in output):

${formattedKnowledge}
${icpSection}
${headlineGuidelines}${existingPostsSection}

CANDIDATE KEYWORDS to pick ${args.selectCount} from:
${JSON.stringify(args.candidateKeywords, null, 2)}

TASK:
- Choose ${args.selectCount} keywords with the highest commercial plus founder or CTO intent.
- For each, create a headline using ONE of the headline formulas being Numbers, How-To, Curiosity Gap, Direct Benefit, or Contrarian.
- CRITICAL: No colons in headlines. Write flowing titles like \"How to Build a Dev Team That Ships\" not \"Building Teams. A Complete Guide\"
- Outline MUST start with a HOOK section that describes the TARGET READER'S stuck moment${args.targetIcp ? ` (write it for ${args.targetIcp.persona_name} - their frustration: "${args.targetIcp.the_crap_he_deals_with.substring(0, 80)}...")` : ''}, not definitions or intros.
- Include a \"Common Mistakes\" or \"What Most Get Wrong\" section.
- End outline with actionable next steps section.${args.targetIcp ? `
- ICP ALIGNMENT CHECK: Before finalizing each topic, ask "Would ${args.targetIcp.persona_name} (${args.targetIcp.biographics.title}) say 'that's me' reading this headline?" If not, rewrite it.
- The outline notes should reference specific pain points and language from the TARGET READER PROFILE above.` : ''}

SELL MONEY, NOT SERVICES (Critical topic framing rule):
- Headlines must target BUSINESS PROBLEMS, not services.
  Wrong: "How to Migrate from .NET to Next.js"  (describes a service)
  Right: "Why Your Engineering Team Keeps Missing Deadlines"  (describes a business problem; migration is the answer inside)
  Wrong: "Building Real-Time Dashboards"  (describes a deliverable)
  Right: "Why Your Ops Team Is Always the Last to Know"  (describes a business pain; the dashboard is the answer)
- At least ONE outline section must address the COST OF INACTION with a specific dollar or time consequence.
  This surfaces the "size of problem = size of budget" logic and attracts high-ticket clients.${args.targetIcp ? `
- For ${args.targetIcp.persona_name}: cost of inaction context is "${args.targetIcp.cost_of_inaction.substring(0, 120)}..."
  Use this to frame the outline's hook section and at least one middle section.` : ''}

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
