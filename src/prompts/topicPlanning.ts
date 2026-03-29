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

CORE PRINCIPLE: Write to get hired, not to rank.
Target persona: Startup founders, SMB owners, mid-level CTOs who are confused, budget-conscious, and searching with problem language.

SEARCH INTENT PRIORITY (highest to lowest):
1. TRANSACTIONAL (HIGHEST PRIORITY) - "cost to build [X]", "hire developer for [X]", "best tech stack for [X]"
2. COMMERCIAL INVESTIGATION - "firebase vs supabase", "custom software vs SaaS"
3. PROBLEM-AWARE - "why my app is slow", "why projects fail"
4. AVOID: Pure informational like "what is AI"

CRITICAL: Prioritize keywords that signal LARGE, COSTLY business problems.
"Size of problem = size of budget" - a client with a $200k/year technical debt problem has budget for $50k engagement.

CRITICAL: Never use colons in headlines or titles. Write naturally flowing titles without colons or em dashes.
CRITICAL: If given existing posts, you MUST create completely different content angles - never repeat similar topics.
CRITICAL: Target BUSINESS PROBLEMS, not services. The client's deliverable is the answer inside the post, never the topic itself.

HEADLINE FORMULA (Pain + Outcome + Curiosity):
Every headline MUST include all 3 elements. Then optimize for CTR.

CTR-OPTIMIZED TITLE PATTERNS (use these):
1. Warning + Specific Number: "Your Software Budget Will Blow Up — Unless You Fix These 3 Things"
2. Pain + Control Promise: "Why Your Budget Keeps Exploding (And How to Actually Control It)"
3. Stakes + Curiosity: "The $200K Mistake Most Founders Make When Hiring Developers"
4. Direct Challenge: "Stop Trying to Build the Perfect Product (Here's What Actually Works)"
5. Insider Secret: "The Hidden Reason Your Engineering Team Is Missing Deadlines"

REQUIRED: Every title must have:
- SPECIFIC PAIN (budget exploding, team missing deadlines)
- CLEAR OUTCOME (control it, fix it, avoid it)
- CURIOSITY GAP (number, secret, hidden reason, unless you...)

GOOD examples (CTR-optimized):
- "Your Software Budget Will Blow Up — Unless You Fix These 3 Things"
- "Why Your Budget Keeps Exploding (And How to Actually Control It)"
- "7 Database Mistakes That Cost Startups $100K+"
- "The Hidden Reasons Your Enterprise AI Project Is Stalled"

BAD examples (boring/generic):
- "Technical Debt in Software" (no pain, no outcome, no curiosity)
- "Building Teams: A Complete Guide" (colon, generic, no emotional hook)
- "Software Development Best Practices" (no stakes, no urgency)${args.targetIcp ? `
CRITICAL: Every topic MUST be designed so "${args.targetIcp.persona_name}" reads the headline and immediately thinks "that's me."
The pain point, language, and outcome must resonate with their profile.` : ''}`,
    user: `AUTHOR KNOWLEDGE (must reflect in output):

${formattedKnowledge}
${icpSection}
${headlineGuidelines}${existingPostsSection}

CANDIDATE KEYWORDS to pick ${args.selectCount} from:
${JSON.stringify(args.candidateKeywords, null, 2)}

TASK:
- Choose ${args.selectCount} keywords with HIGHEST commercial intent following the Search Intent Priority above.
- Prefer keywords containing: "cost", "hire", "vs", "alternatives", "best", "mistakes", "failing"
- For each, create a headline using the Pain + Outcome + Curiosity formula.
- CRITICAL: No colons in headlines. Write flowing titles like "How to Build a Dev Team That Ships" not "Building Teams. A Complete Guide"
- Outline MUST follow the 6-step structure: Hook → Problem Breakdown → Why It Fails → Better Approach → Actionable Steps → Soft CTA
- Include a "Common Mistakes" or "What Most Get Wrong" section.
- At least ONE outline section must address the COST OF INACTION with a specific dollar consequence.${args.targetIcp ? `
- ICP ALIGNMENT CHECK: Before finalizing each topic, ask "Would ${args.targetIcp.persona_name} (${args.targetIcp.biographics.title}) say 'that's me' reading this headline?" If not, rewrite it.
- The outline notes should reference specific pain points and language from the TARGET READER PROFILE above.` : ''}

APPROVED TOPIC TYPES (prioritize these):
💰 Money Topics: Cost, hiring, tools comparison, build vs buy
🧠 Authority Topics: Case studies (from author knowledge), failures, lessons learned

⚠️ AVOID:
- Abstract strategy
- Industry-specific jargon (pharma AI, etc.) unless necessary
- Generic definitions
- Writing like a consultancy report

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
