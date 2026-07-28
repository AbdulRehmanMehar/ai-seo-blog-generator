import { type AuthorKnowledge, formatKnowledgeForPrompt } from '../knowledge/authorKnowledge.js';
import { type IcpPersona, formatIcpForPrompt } from '../knowledge/icpKnowledge.js';
import { getHeadlineGuidelines } from './conversionCopy.js';

// ─── NICHE DEFINITION ────────────────────────────────────────────────────────
//
// SINGLE TARGET NICHE (from the Brand Operating System, July 2026; industries
// re-validated via deep market research, July 28 2026 — see data/brand.json
// target_market for the current canonical list):
//   Removing digital friction for GROWING BUSINESSES — service businesses
//   (hospitality, veterinary and med spa practices, real estate, recruiting
//   and staffing, e-commerce, small manufacturers and distributors,
//   construction and renovation firms, management and business consulting
//   firms) and small digital-product companies whose systems grew slower than
//   the business: clunky booking/intake flows, disconnected tools, manual
//   workflows, aging websites, and repetitive work ready for automation/AI.
//   Explicitly excluded: home services trades (HVAC/plumbing/electrical/
//   landscaping/roofing) — confirmed NO-GO via real search-demand data, the
//   ServiceTitan/Housecall Pro ecosystem already owns that space.
//
// FOUR BUYER PROFILES ($3k–$50k engagements, direct decision makers, no
// procurement cycle):
//   1. Owner Omar        — owner of a growing service business (15–150 staff), $20k-$50k
//   2. Founder Nadia      — non-technical founder of a digital product, $20k-$60k
//   3. Ops-Lead Olivia    — operations/GM who champions the project to the owner, $20k-$50k
//   4. Proprietor Priya   — owner-operator of a single-location business (5-30 staff), $3k-$15k
//
// FOUR BUYER JOURNEY STAGES (with target content distribution):
//   Stage 1 — AWARENESS     (40%): Problem-framing, diagnostic, "you might have this"
//   Stage 2 — CONSIDERATION (30%): Checklists, comparisons, how-to, build-vs-buy
//   Stage 3 — DECISION      (20%): Trigger-event content ("your admin just quit")
//   Stage 4 — VALIDATION    (10%): Methodology explainers, real case walkthroughs
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
    system: `You are a senior content strategist specialising in ONE niche only:

NICHE: Removing digital friction for growing businesses — clunky booking and intake flows,
disconnected tools and double data entry, manual workflows ready for automation or AI
assistants, aging websites and web apps, and systems that don't talk to each other.

TARGET BUYERS ($20k–$50k engagements, decided directly by the buyer — no procurement):
- Owners of growing service businesses (hospitality, clinics, real estate, recruiting,
  e-commerce, home services; 15–150 staff) whose systems grew slower than the business.
- Non-technical founders of digital products who need a senior partner to own delivery.
- Operations leads / general managers who champion the fix to the owner.

HARD RULE — NICHE LOCK:
Every topic you generate MUST be relevant to at least one of these buyers.
You MUST REJECT any keyword or topic that does not clearly serve:
- Booking, scheduling, intake, or customer-portal friction
- Disconnected tools, integrations, and double data entry
- Manual workflows and reporting ready for automation or practical AI
- Slow or aging websites and web apps hurting customer experience
- MVP builds/rebuilds and rescuing stalled products for non-technical founders
- Choosing and working with a technology partner at this budget level

Do NOT generate topics for ENTERPRISE buyers. Out of scope: defense contractors, bank
compliance programs (KYC/AML), pharma R&D, Fortune 500 IT, Series B / acquisition /
technical due diligence content, and any topic whose natural stakes are millions of
dollars. Those readers will never hire us, so those topics are worthless.

EXPLICITLY EXCLUDED — reject even if the keyword sounds adjacent:
- KYC/AML, banking compliance, defense security, pharma compliance
- Cryptocurrency or blockchain development
- M&A technical due diligence, exit valuation, Series B fundraising content
- Enterprise architecture and CTO-level content written for large engineering organizations

BUYER JOURNEY STAGES — You MUST distribute topics across all four stages:
Each topic must be tagged with its buyer journey stage in the output JSON.

STAGE 1 — AWARENESS (reader thinks "I have this problem but it's not urgent yet")
- Content type: diagnostic posts, problem-framing, "7 signs your systems don't talk to each other"
- Tone: educational, observational, no hard sell
- Keywords signal: "why do customers abandon online booking", "signs you've outgrown spreadsheets", "manual data entry problems"
- CTA style: soft offer, email capture, checklist download

STAGE 2 — CONSIDERATION (reader thinks "I need to fix this in the next 6 months")
- Content type: checklists, comparison posts (off-the-shelf vs custom, tool A vs tool B), phased plans
- Tone: practical, framework-driven, positions the author as the expert guide
- Keywords signal: "how to automate client intake", "connect CRM to scheduling software", "custom booking system vs plugin"
- CTA style: specific diagnostic offer ("send me how your intake works, I'll map what to automate first")

STAGE 3 — DECISION (reader thinks "something just happened and I need help NOW")
- Content type: trigger-event posts ("your office manager just quit", "your developer disappeared mid-project", "busy season starts in 8 weeks")
- Tone: urgent, specific, written for someone with a live trigger — calm, never panicked
- Keywords signal: "developer abandoned my project", "replace spreadsheet system fast", "automate before peak season"
- CTA style: immediate value offer ("send me your setup, I'll tell you what to stabilize first")

STAGE 4 — VALIDATION (reader thinks "I've decided to hire someone — is it this person?")
- Content type: methodology explainers, real project walkthroughs, how-I-work posts
- Tone: confident, proof-driven, shows the specific work and real outcomes
- Keywords signal: "how to choose a software development partner", "what a workflow automation project looks like"
- CTA style: zero-friction entry point ("start with a workflow audit, no commitment")

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

BAD: "Your Booking Flow — Here's Why Customers Abandon It" (has em dash)
GOOD: "Why Customers Abandon Your Booking Flow Halfway. And What Smooth Looks Like."

HIGH-CONVERTING TITLE PATTERNS (friction-first, never dollar-scare):
1. "Why Customers Abandon Your [Booking/Intake/Checkout] Halfway"
2. "Your Team Isn't Slow. Your Tools Are."
3. "7 Signs Your Business Has Outgrown Its Spreadsheets"
4. "The Monday Report Your Ops Manager Shouldn't Be Building by Hand"
5. "What to Do When Your Developer Disappears Mid-Project"

CRITICAL: Target BUSINESS PROBLEMS, not services. "Why customers abandon your booking flow"
not "Booking system development services". NEVER put dollar figures in titles.`,

    user: `AUTHOR KNOWLEDGE (must reflect in output):

${formattedKnowledge}
${icpSection}
${headlineGuidelines}${existingPostsSection}${args.gscInsights ? `\n\n${args.gscInsights}` : ''}${args.contentIntelligenceBrief ? `\n\n${args.contentIntelligenceBrief}` : ''}

CANDIDATE KEYWORDS to select from (choose only niche-relevant ones):
${JSON.stringify(args.candidateKeywords, null, 2)}

TASK:
Select exactly ${args.selectCount} keywords that are relevant to the niche.
If fewer than ${args.selectCount} niche-relevant keywords exist in the list, select as many as possible.
REJECT any keyword not directly related to removing digital friction for growing businesses
(booking/intake flows, disconnected tools, workflow automation, practical AI, aging websites,
MVP builds for non-technical founders, choosing a technology partner).

For each selected keyword:
1. Assign a buyer_journey_stage: "awareness" | "consideration" | "decision" | "validation"
2. Write a headline using the Pain + Outcome + Curiosity formula — no colons, no em dashes, no dollar figures
3. Write a 6-section outline following: Hook → Problem Breakdown → Why It Fails → Better Approach → Actionable Steps → Soft CTA
4. Include at least one section that addresses the COST OF INACTION in operational terms (hours, delays, abandoned bookings, burnout) — never an invented dollar consequence
5. For Stage 3 (decision) topics: include a section written specifically for someone whose trigger just fired (key admin resigned, developer disappeared, busy season approaching)

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
