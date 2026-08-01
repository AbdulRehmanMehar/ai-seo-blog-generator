/**
 * LLM-judged holistic review for solutions pages — mirrors src/prompts/reviewer.ts's
 * scoring shape (start at 100, subtract penalties, add bonuses, clamp 0-100, threshold
 * 70) but with a solutions-specific rubric, not a copy of blog's blog-narrative
 * categories (WEAK_HOOK/MISSING_FRICTION_SCENE/etc. don't apply to a landing page).
 *
 * Deliberately NOT re-checking things findContentViolation() already catches for free
 * deterministically (fabricated numbers, NDA names, off-brand vocabulary/fear patterns,
 * pricing scope, AI-tell words) — this rubric is for judgment calls no regex can make:
 * is the headline actually strong, do the pain points feel specific to this niche or
 * templated, is the CTA compelling, does the page address off-the-shelf competition
 * honestly when it needs to.
 */

import type { SolutionsPageContent } from '../services/solutionsService.js';

export const SOLUTIONS_REVIEW_CRITERIA = {
  WEAK_HEADLINE: -15,
  KEYWORD_TOPIC_DRIFT: -20,
  GENERIC_PAIN_POINTS: -15,
  LACKS_CREDIBILITY: -15,
  WEAK_CTA: -10,
  OFF_BRAND_TONE: -10,
  TOO_FORMAL: -10,
  FREELANCER_IDENTITY: -15,
  TECH_FIRST_FRAMING: -15,
  OBJECTION_NOT_ADDRESSED: -10,
  NICHE_SPECIFICITY: 10,
  SPECIFIC_NUMBERS: 5,
  STRONG_CTA: 5
} as const;

export const SOLUTIONS_BASE_SCORE = 100;
export const SOLUTIONS_PASS_THRESHOLD = 70;

export function solutionsReviewerPrompt(args: {
  content: SolutionsPageContent;
  serviceName: string;
  /** For service-level pages, pass a cross-industry label (e.g. "growing service businesses (cross-industry service page)"). */
  nicheName: string;
}) {
  const system = `You are a ruthless reviewer for commercial "solutions" landing pages (service x niche, NOT blog posts). This page sells "${args.serviceName}" to "${args.nicheName}" — score how well it does that.

PENALTY CATEGORIES (go through each, deduct points found):
- WEAK_HEADLINE (-15): the headline is vague, generic, or doesn't name a concrete outcome for this niche.
- KEYWORD_TOPIC_DRIFT (-20): the headline, subheadline, or meta_title revolve around a DIFFERENT product/service category than "${args.serviceName}" (e.g. a booking-system page whose headline is actually about POS/payment terminals). This is the most serious defect — it means the page is selling the wrong thing.
- GENERIC_PAIN_POINTS (-15): the pain points read like a template with the niche name swapped in, not something genuinely specific to how "${args.nicheName}" businesses experience this problem.
- LACKS_CREDIBILITY (-15): the proof points are truthful (that's checked elsewhere) but unconvincing or too vague to build trust.
- WEAK_CTA (-10): the call to action is generic ("contact us") or doesn't name a concrete next step.
- OFF_BRAND_TONE (-10): hype or fear-mongering NOT already on a fixed blocklist — a calm senior-advisor tone is expected, not a marketer's.
- TOO_FORMAL (-10): stiff, corporate phrasing instead of plain, direct prose.
- FREELANCER_IDENTITY (-15): the author LABELS themselves a freelancer, coder, or programmer rather than a partner/advisor (e.g. "as a freelance developer, I..."). The pronoun choice itself is brand-mandated (some sites deliberately speak as one person using "I") — first-person singular voice is NEVER by itself this defect; only explicit self-labeling or gig-work framing is.
- TECH_FIRST_FRAMING (-15): the headline or an early section opens with a technology name instead of the business problem or outcome.
- OBJECTION_NOT_ADDRESSED (-10): most buyers in this space default to comparing off-the-shelf software first — the faq MUST honestly address why a custom fix beats buying a tool. Deduct if it's missing, dismissive, or dishonest about when off-the-shelf is actually fine.

BONUS CATEGORIES:
- NICHE_SPECIFICITY (+10): the page could not be reused for a different industry without a rewrite — it's genuinely built for "${args.nicheName}".
- SPECIFIC_NUMBERS (+5): proof points use specific, credible figures (not vague claims).
- STRONG_CTA (+5): the CTA is specific and lowers the reader's perceived risk of reaching out.

RULES:
- Assign each issue the SINGLE most specific applicable code. Don't penalize the same sentence under two overlapping categories (e.g. don't deduct both TECH_FIRST_FRAMING and WEAK_HEADLINE for the same headline problem — pick whichever is the more precise diagnosis).
- Do NOT flag fabricated numbers, NDA client names, off-brand blocklist words, pricing placement, or AI-tell vocabulary — those are already checked deterministically elsewhere. Focus only on the judgment calls above.
- Output valid JSON only, no markdown fences.

Return JSON:
{
  "score": number (start at 100, apply penalties/bonuses, you compute the final number),
  "passed": boolean (score >= ${SOLUTIONS_PASS_THRESHOLD}),
  "issues": [{"code": "CRITERIA_CODE", "message": "specific, cites what and where", "penalty": negative number}],
  "bonuses": [{"code": "CRITERIA_CODE", "message": "what it did well", "bonus": positive number}],
  "rewriteInstructions": "specific instructions to fix the issues above, or null if passed"
}`;

  const user = `SERVICE: ${args.serviceName}
NICHE: ${args.nicheName}

PAGE TO REVIEW:
${JSON.stringify(args.content, null, 2)}

Review this page against the rubric. Be specific about what and where. Output valid JSON only.`;

  return { system, user };
}
