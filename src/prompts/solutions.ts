/**
 * Prompts for solutions pages: commercial, mid-funnel landing pages, in two tiers:
 *  - Service-level pages (one per service, cross-industry): the primary standalone
 *    sales page, linked from the site nav / /solutions hub.
 *  - Niche pages (one service x one niche): generated ONLY where real, curated
 *    proof exists for that niche (case_studies.json niche_fit — the proof gate).
 *
 * DataForSEO keyword research was REMOVED from this pipeline (2026-08-01): a live
 * full-matrix test proved Ads data structurally can't see the long-tail demand
 * these pages serve (every niche-qualified phrasing measured zero volume; every
 * measurable category term was shopping-intent owned by review aggregators).
 * Instead, pages are written in the reader's literal problem language — the same
 * mode behind every query this site actually ranks for in GSC — and validated
 * retroactively via the existing free GSC sync, not predicted upfront via paid
 * research. Grounding comes from:
 *  1. The full brand voice + NDA-safe evidence inventory (data/brand.json,
 *     data/case_studies.json via brandKnowledge.ts) — proof-point fabrication
 *     risk is highest on a page that exists to sell a service.
 *  2. For niche pages: the specific case studies matched to that niche
 *     (getCaseStudiesForNiche), featured as the page's core proof.
 *  3. A matching ICP persona (data/icps.json), when the niche has one mapped.
 */

import { getReadingLevelGuidelines } from './readingLevel.js';
import { FORBIDDEN_WORDS } from './taxonomy.js';
import { getBrandVoiceGuidelines, getRealEvidenceBlock, type NicheCaseStudy } from '../knowledge/brandKnowledge.js';
import { formatIcpForPrompt, type IcpPersona } from '../knowledge/icpKnowledge.js';
import type { VoicePerspective } from '../services/websiteService.js';
import { env } from '../config/env.js';

/** Kept for the stored-research shape in solutions.target_keywords_json (legacy rows) and the flag-gated researchNicheSeo(). */
export interface SeoKeywordCandidate {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  difficulty: number | null;
}

export interface SerpFinding {
  keyword: string;
  top: Array<{ position: number; domain: string; title: string }>;
}

const PRONOUN_RULES: Record<VoicePerspective, string> = {
  first_person_singular: 'Use ONLY first-person singular pronouns (I, me, my, mine). This brand is bound to one person, not a team or company — NEVER write "we", "our", "us", or "ours", even once, anywhere on the page.',
  first_person_plural: 'Use first-person plural pronouns (we, us, our) throughout — this brand speaks as a team.',
  third_person: 'Refer to the brand in the third person (the team, the company) throughout — never "I" or "we".'
};

function matchedProofBlock(caseStudies: NicheCaseStudy[]): string {
  const stories = caseStudies.map((c) =>
    `- ${c.title} — ${c.businessType}.
  Friction before: ${c.frictionBefore}
  What changed: ${c.whatChanged}
  Evidence: ${c.evidence.join('; ')}`
  ).join('\n');
  return `MATCHED PROOF FOR THIS INDUSTRY — real, NDA-safe stories from this exact kind of business. These are the page's core credibility; weave at least one into proof_points concretely (what the business struggled with, what changed), not as a vague allusion:
${stories}`;
}

/** Shared hard-rules block for both page tiers. */
function hardRules(pronounRule: string): string {
  return `HARD RULES:
- ${pronounRule}
- No fabricated clients, stats, or case studies beyond the evidence inventory below.
- Pricing may ONLY appear inside an faq answer, and only as the engagement range stated in the brand voice below, phrased as a range (e.g. "a focused first phase typically starts around $3k-$15k"), never a single invented number like "$5,000". Never state a dollar figure in the headline, subheadline, cta, meta_title, or meta_description — those can be shown as a raw snippet, and a specific price there reads as a fixed quote, not a qualified estimate.
- Plain prose. No em dashes. No colons in the headline or meta_title. No markdown headers, bold, or bullet symbols.
- Do not use these AI-tell words: ${FORBIDDEN_WORDS.join(', ')}.
- Return ONLY valid JSON, no markdown fences.`;
}

const JSON_SHAPE = `{
  "headline": "...",
  "subheadline": "...",
  "pain_points": ["...", "...", "..."],
  "approach": [{"step": "...", "description": "..."}],
  "proof_points": ["...", "..."],
  "faq": [{"question": "...", "answer": "..."}],
  "cta": "...",
  "meta_title": "...",
  "meta_description": "..."
}`;

/**
 * Niche page (one service x one industry). Only called after the proof gate
 * passed, so matchedCaseStudies is always non-empty.
 */
export function solutionsPageContentPrompt(args: {
  serviceName: string;
  servicePitch: string | null;
  nicheName: string;
  websiteDomain: string;
  brandName: string;
  icp: IcpPersona | null;
  matchedCaseStudies: NicheCaseStudy[];
  defaultCtaText: string | null;
  defaultCtaUrl: string | null;
  voicePerspective: VoicePerspective;
  /** Set on a retry after the previous attempt failed a deterministic check (e.g. too short) — states exactly what to fix, the same way postRewriter.ts feeds review feedback back into a regeneration. */
  retryFeedback?: string;
}) {
  const pronounRule = PRONOUN_RULES[args.voicePerspective];

  const system = `You write commercial, mid-funnel "solutions" landing pages for ${args.brandName} (${args.websiteDomain}) — this is NOT a blog post.
${getReadingLevelGuidelines()}
This page sells one service (${args.serviceName}) to one specific industry (${args.nicheName}). It must read as a real, specific offer built for that industry's actual problems, never as a generic template with the industry name swapped in. Use the niche name and the breadth it implies as given — do not narrow it to an unstated sub-segment.

VOICE: ${pronounRule}

SEARCH LANGUAGE: There is no target keyword for this page. Instead, write the headline, subheadline, pain_points, and faq questions in the READER'S literal problem language — the messy, specific phrases a busy owner actually types or says out loud when this breaks (e.g. what gets double-booked, what gets re-typed where, what report takes all morning). Concrete problem phrasing is what long-tail searches match against; polished marketing phrasing matches nothing.

DEPTH: This page must read as substantive, useful content, not a thin summary — the whole page should total at least ${env.SOLUTIONS_MIN_WORDS} words. Concretely: each pain point is 2-3 full sentences (the specific breakdown AND why it costs the business something), each approach step's description is 2-3 sentences (not just naming the step — explain what actually happens and why it matters for THIS niche), and each faq answer is 3-5 sentences. Thin, clipped, one-line answers read as low-effort to both readers and search engines.

${matchedProofBlock(args.matchedCaseStudies)}

STRUCTURE (return as JSON):
- headline: names the outcome for this niche, in the reader's own problem-or-outcome words. Never leads with a technology name.
- subheadline: one sentence naming the specific friction this niche feels.
- pain_points: 3-5 SPECIFIC problems this niche has related to ${args.serviceName.toLowerCase()}, not generic software complaints. Ground each in an observable, concrete task or breakdown (what data gets re-typed, what step gets missed, how long something takes) — never a speculative claim about how an unnamed employee or customer privately feels or will react (e.g. do not write that staff "will quit" or are "about to snap"; that reads as manufactured, not factual).
- approach: 3-6 steps describing concretely how the engagement works for this niche.
- proof_points: capability statements backed EXCLUSIVELY by the real evidence inventory below, leading with the MATCHED PROOF stories above. If a claim isn't in the inventory, state it qualitatively with NO number instead of inventing one.
- faq: 3-6 question/answer pairs a real buyer in this niche would ask before hiring. One faq entry MUST directly and honestly address why a custom fix beats buying an off-the-shelf tool for this niche (sometimes off-the-shelf is genuinely the right call for a generic need; the honest case for a custom/partner approach is when the workflow, integrations, or existing tools are specific enough that no off-the-shelf product fits cleanly).
- cta: one short, specific call to action naming the concrete next step (not a generic "Contact us"). ${args.defaultCtaText ? `Use or closely adapt the site's standard call to action: "${args.defaultCtaText}"${args.defaultCtaUrl ? ` (links to ${args.defaultCtaUrl})` : ''}.` : 'Name a concrete first step (e.g. a short discovery call).'}
- meta_title: under 60 chars, no colon, phrased around the niche's problem or outcome (not a software-category phrase).
- meta_description: under 155 chars.

${hardRules(pronounRule)}

${getBrandVoiceGuidelines()}

${getRealEvidenceBlock()}
${args.icp ? `\n${formatIcpForPrompt(args.icp)}` : ''}`;

  const user = `${args.retryFeedback ? `IMPORTANT — FIX THIS FROM YOUR LAST ATTEMPT: ${args.retryFeedback}\n\n` : ''}SERVICE: ${args.serviceName}
${args.servicePitch ? `Service pitch: ${args.servicePitch}\n` : ''}NICHE: ${args.nicheName}

Write the solutions page. Return JSON:
${JSON_SHAPE}`;

  return { system, user };
}

/**
 * Service-level page (one per service, cross-industry) — the primary standalone
 * sales page at /solutions/{serviceSlug}, linked from the site nav. Draws proof
 * from across every industry rather than one niche's matched stories.
 */
export function servicePageContentPrompt(args: {
  serviceName: string;
  servicePitch: string | null;
  websiteDomain: string;
  brandName: string;
  nichesWithProof: Array<{ nicheName: string; caseStudies: NicheCaseStudy[] }>;
  defaultCtaText: string | null;
  defaultCtaUrl: string | null;
  voicePerspective: VoicePerspective;
  retryFeedback?: string;
}) {
  const pronounRule = PRONOUN_RULES[args.voicePerspective];

  const industryProof = args.nichesWithProof.length > 0
    ? `INDUSTRY PROOF — real, NDA-safe stories grouped by the industries this service has already helped. Use them two ways: (1) weave the strongest into proof_points, and (2) let the spread of industries itself be a credibility point (this service is proven across several kinds of business, not a one-vertical trick):
${args.nichesWithProof.map((n) =>
    `${n.nicheName}:
${n.caseStudies.map((c) => `- ${c.title} — ${c.businessType}. ${c.frictionBefore} ${c.whatChanged} Evidence: ${c.evidence.join('; ')}`).join('\n')}`
  ).join('\n\n')}`
    : '';

  const system = `You write commercial "solutions" landing pages for ${args.brandName} (${args.websiteDomain}) — this is NOT a blog post.
${getReadingLevelGuidelines()}
This is the SERVICE-LEVEL page for ${args.serviceName}: the main standalone sales page a prospect lands on from the site navigation, a proposal link, or a referral. It sells this one service to any growing service business, using specific industry stories as proof. It must stand completely on its own — a reader arriving cold gets the full picture: what breaks, how the engagement works, why trust this person, what to do next.

VOICE: ${pronounRule}

SEARCH LANGUAGE: There is no target keyword. Write the headline, pain_points, and faq questions in the reader's literal problem language — the specific phrases an owner types or says when this class of problem bites (what gets re-typed, what gets double-entered, which spreadsheet secretly runs the business). Concrete problem phrasing is what long-tail searches match against.

DEPTH: at least ${env.SOLUTIONS_MIN_WORDS} words across the page. Each pain point 2-3 full sentences, each approach step description 2-3 sentences, each faq answer 3-5 sentences.

${industryProof}

STRUCTURE (return as JSON):
- headline: names the outcome this service delivers, in plain problem-or-outcome words. Never leads with a technology name.
- subheadline: one sentence naming the friction this service removes.
- pain_points: 3-6 SPECIFIC problems businesses hit in this service's territory, each grounded in an observable, concrete task or breakdown — never speculative claims about how unnamed people privately feel.
- approach: 3-6 steps describing concretely how an engagement works, start to finish.
- proof_points: capability statements backed EXCLUSIVELY by the real evidence inventory below, drawing on the industry proof above — the cross-industry spread is itself proof.
- faq: 4-6 question/answer pairs a real buyer would ask before hiring. One entry MUST honestly address why a custom fix beats buying an off-the-shelf tool (sometimes off-the-shelf is genuinely right for a generic need; the honest case for custom is when the workflow, integrations, or existing tools are specific enough that nothing off-the-shelf fits cleanly). Another entry should address how the engagement works for a business whose exact industry isn't listed above.
- cta: one short, specific call to action naming the concrete next step. ${args.defaultCtaText ? `Use or closely adapt the site's standard call to action: "${args.defaultCtaText}"${args.defaultCtaUrl ? ` (links to ${args.defaultCtaUrl})` : ''}.` : 'Name a concrete first step (e.g. a short discovery call).'}
- meta_title: under 60 chars, no colon, phrased around the outcome (not a software-category phrase).
- meta_description: under 155 chars.

${hardRules(pronounRule)}

${getBrandVoiceGuidelines()}

${getRealEvidenceBlock()}`;

  const user = `${args.retryFeedback ? `IMPORTANT — FIX THIS FROM YOUR LAST ATTEMPT: ${args.retryFeedback}\n\n` : ''}SERVICE: ${args.serviceName}
${args.servicePitch ? `Service pitch: ${args.servicePitch}\n` : ''}
Write the service-level solutions page. Return JSON:
${JSON_SHAPE}`;

  return { system, user };
}
