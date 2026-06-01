import { type AuthorKnowledge, formatKnowledgeForPrompt } from '../knowledge/authorKnowledge.js';
import { type IcpPersona, formatIcpForPrompt } from '../knowledge/icpKnowledge.js';
import { getHeadlineGuidelines } from './conversionCopy.js';

// ─── NICHE DEFINITION ────────────────────────────────────────────────────────
//
// SINGLE TARGET NICHE:
//   SaaS / HealthTech / Fintech founders, CTOs, and VPs of Engineering
//   who have a legacy .NET or aging codebase and are 6–18 months from
//   a Series B raise or acquisition — and whose technical debt is the
//   primary risk to their valuation or fundraising close.
//
// TWO BUYER PROFILES:
//   1. Modernizing Michael — CTO/VP Eng at B2B SaaS, Series B window
//   2. Exit-Ready Sarah   — Founder preparing for acquisition / sale
//
// FOUR BUYER JOURNEY STAGES (with target content distribution):
//   Stage 1 — AWARENESS     (40%): Problem-framing, diagnostic, "you might have this"
//   Stage 2 — CONSIDERATION (30%): Checklists, comparisons, cost breakdowns, how-to
//   Stage 3 — DECISION      (20%): Emergency playbooks, trigger-event content, calculators
//   Stage 4 — VALIDATION    (10%): Case studies, methodology explainers, process posts
//
// ─────────────────────────────────────────────────────────────────────────────

export function topicPlanningPrompt(args: {
  knowledge: AuthorKnowledge;
  candidateKeywords: Array<{ keyword: string; volume: number | null; difficulty: number | null; cpc: number | null; intent: string | null }>;
  selectCount: number;
  targetWebsite?: string;
  existingPosts?: Array<{ title: string; keyword: string }>;
  targetIcp?: IcpPersona;
  contentIntelligenceBrief?: string;
  gscInsights?: string;
}) {
  const formattedKnowledge = formatKnowledgeForPrompt(args.knowledge);
  const headlineGuidelines = getHeadlineGuidelines();

  const icpSection = args.targetIcp
    ? `\n${formatIcpForPrompt(args.targetIcp)}\n`
    : '';

  let existingPostsSection = '';
  if (args.existingPosts && args.existingPosts.length > 0) {
    const postsList = args.existingPosts
      .map(p => `- "${p.title}" (keyword: ${p.keyword})`)
      .join('\n');
    existingPostsSection = `

⚠️ EXISTING CONTENT FOR ${args.targetWebsite?.toUpperCase() || 'THIS WEBSITE'} — DO NOT DUPLICATE:
The following posts already exist. Create DIFFERENT angles, sub-problems, or buyer journey stages.

${postsList}
`;
  }

  // Calculate the distribution targets for this batch
  const total = args.selectCount;
  const awarenessTarget    = Math.round(total * 0.4);
  const considerationTarget = Math.round(total * 0.3);
  const decisionTarget     = Math.round(total * 0.2);
  const validationTarget   = Math.max(0, total - awarenessTarget - considerationTarget - decisionTarget);

  return {
    system: `You are a senior B2B content strategist specialising in ONE niche only:

NICHE: Legacy software modernization and pre-acquisition / pre-Series-B technical debt cleanup
for SaaS, HealthTech, and Fintech companies with .NET or aging codebases.

TARGET BUYERS:
- CTOs and VPs of Engineering at B2B SaaS companies 6–12 years old, facing a Series B raise in 12 months.
- Founders of HealthTech / Fintech SaaS ($2M–$15M ARR) preparing for acquisition or sale.

HARD RULE — NICHE LOCK:
Every topic you generate MUST be relevant to at least one of these two buyers in this niche.
You MUST REJECT any keyword or topic that does not clearly serve:
- Legacy .NET or aging codebase modernization
- Technical debt before a Series B raise or acquisition
- Pre-acquisition technical due diligence preparation
- Valuation impact of technical debt
- AI integration blocked by legacy systems
- Code quality, architecture review, or security gaps pre-exit

Do NOT generate topics about: generic hiring, general software development, logistics, pharma, real estate, defense, retail, luxury, telecom, or any other niche. Those audiences are out of scope.

EXPLICITLY EXCLUDED — reject even if the keyword sounds adjacent:
- KYC/AML compliance for banks (this is a banking operations topic, not a software modernization topic)
- Cryptocurrency or blockchain development
- Healthcare compliance (HIPAA) as a standalone topic — only include if it is about codebase modernization before acquisition
- General AI consulting or AI strategy — only include if directly connected to legacy stack modernization blocking AI adoption

BUYER JOURNEY STAGES — You MUST distribute topics across all four stages:
Each topic must be tagged with its buyer journey stage in the output JSON.

STAGE 1 — AWARENESS (reader thinks "I have this problem but it's not urgent yet")
- Content type: diagnostic posts, problem-framing, "7 signs your codebase..." articles
- Tone: educational, observational, no hard sell
- Keywords signal: "what is technical debt", "legacy system risks", "signs your codebase is aging"
- CTA style: soft offer, email capture, checklist download

STAGE 2 — CONSIDERATION (reader thinks "I need to fix this in the next 6 months")
- Content type: checklists, comparison posts (options A vs B), cost breakdowns, 90-day plans
- Tone: practical, framework-driven, positions the author as the expert guide
- Keywords signal: "how to fix technical debt", "legacy modernization checklist", "technical due diligence prep"
- CTA style: specific diagnostic offer ("send me your codebase situation, I'll tell you what's at risk")

STAGE 3 — DECISION (reader thinks "something just happened and I need help NOW")
- Content type: emergency playbooks, trigger-event posts, "what to do when you receive an LOI"
- Tone: urgent, specific, written for someone with a live deadline
- Keywords signal: "technical debt before acquisition", "LOI due diligence timeline", "pre-exit code cleanup"
- CTA style: immediate value offer ("I can run your technical audit in 2 weeks")

STAGE 4 — VALIDATION (reader thinks "I've decided to hire someone — is it this person?")
- Content type: methodology explainers, case studies, process walkthroughs
- Tone: confident, proof-driven, shows the specific work and outcomes
- Keywords signal: "how technical due diligence works", "legacy modernization case study"
- CTA style: zero-friction entry point ("start with a 30-minute architecture call")

REQUIRED DISTRIBUTION for this batch of ${total} topics:
- Stage 1 AWARENESS:     ${awarenessTarget} topic(s)
- Stage 2 CONSIDERATION: ${considerationTarget} topic(s)
- Stage 3 DECISION:      ${decisionTarget} topic(s)
- Stage 4 VALIDATION:    ${validationTarget} topic(s)

HEADLINE RULES — INSTANT REJECTION if violated:
- NO colons anywhere in titles or headings
- NO em dashes (— or –) anywhere — use "and" or "but" or a period instead
- NO asterisks, hashtags, or markdown formatting
- Must include: specific pain + clear outcome + curiosity gap
- Must make either "Modernizing Michael" or "Exit-Ready Sarah" say "that's me" in 2 seconds

BAD: "Your Legacy Codebase — Here's Why It Kills Valuation" (has em dash)
GOOD: "Your Legacy Codebase Is Quietly Killing Your Valuation. Here Is What to Do First."

HIGH-CONVERTING TITLE PATTERNS:
1. "Your [X] Will Kill Your Series B — Unless You Fix This First"
2. "What Happens to Your Valuation When Technical Due Diligence Finds Your Legacy .NET Code"
3. "The 11-Week Code Cleanup That Saved a HealthTech Acquisition"
4. "7 Signs Your Codebase Will Fail Acquisition Due Diligence"
5. "What to Do When You Receive an LOI and Your Backend Is a Mess"

CRITICAL: Target BUSINESS PROBLEMS, not services. "How technical debt destroyed a $4M acquisition" not "Technical debt consulting services."`,

    user: `AUTHOR KNOWLEDGE (must reflect in output):

${formattedKnowledge}
${icpSection}
${headlineGuidelines}${existingPostsSection}${args.gscInsights ? `\n\n${args.gscInsights}` : ''}${args.contentIntelligenceBrief ? `\n\n${args.contentIntelligenceBrief}` : ''}

CANDIDATE KEYWORDS to select from (choose only niche-relevant ones):
${JSON.stringify(args.candidateKeywords, null, 2)}

TASK:
Select exactly ${args.selectCount} keywords that are relevant to the niche.
If fewer than ${args.selectCount} niche-relevant keywords exist in the list, select as many as possible.
REJECT any keyword not directly related to legacy modernization, technical debt, pre-acquisition, or pre-Series-B preparation for SaaS/HealthTech/Fintech.

For each selected keyword:
1. Assign a buyer_journey_stage: "awareness" | "consideration" | "decision" | "validation"
2. Write a headline using the Pain + Outcome + Curiosity formula — no colons, no em dashes
3. Write a 6-section outline following: Hook → Problem Breakdown → Why It Fails → Better Approach → Actionable Steps → Soft CTA
4. Include at least one section that addresses the COST OF INACTION with a specific dollar consequence
5. For Stage 3 (decision) topics: include a section written specifically for someone with an active LOI or imminent due diligence

REQUIRED DISTRIBUTION:
- ${awarenessTarget} topic(s) tagged "awareness"
- ${considerationTarget} topic(s) tagged "consideration"
- ${decisionTarget} topic(s) tagged "decision"
- ${validationTarget} topic(s) tagged "validation"

${args.targetIcp ? `ICP CHECK: Before finalising each topic, ask: would "${args.targetIcp.persona_name}" (${args.targetIcp.biographics.title}) read this headline and say "that's me"? If not, rewrite it.` : ''}

OUTPUT STRICT JSON ONLY:
{
  "selected": [
    {
      "keyword": string,
      "topic": string,
      "buyer_journey_stage": "awareness" | "consideration" | "decision" | "validation",
      "headline_formula_used": string,
      "outline": [ { "heading": string, "level": 2 | 3, "notes": string } ]
    }
  ]
}

CRITICAL OUTPUT RULES:
- Single JSON object, not an array
- No markdown fences
- First character must be { and last must be }
- No trailing commas, no comments
- No colons in any headline or heading
`
  };
}
