import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Brand knowledge loaded from data/brand.json — the single source of truth
 * distilled from Abdul's Brand Operating System and Roadmap documents.
 *
 * Every generation, refresh, humanization, and review prompt pulls its voice
 * guidance from here so the brand can be tuned in one place.
 */

export interface BrandKnowledge {
  identity: {
    brand_name: string;
    what_business_he_is_in: string;
    positioning: string;
    desired_perception: string;
    not_positioned_as: string[];
    transformation: string;
  };
  strategy: {
    purpose: string;
    vision: string;
    mission: string;
    core_belief: string;
    philosophy: string;
    uvp: string;
    brand_promise: string;
  };
  target_market: {
    who_we_serve: string;
    buyer: string;
    engagement_range: string;
    sweet_spot_problems: string[];
    who_we_do_not_target: string;
  };
  promise_architecture: {
    rule: string;
    we_promise: string[];
    we_never_promise: string[];
    consequence_framing: string;
    evidence_vs_promise: string;
  };
  messaging_pillars: Array<{ name: string; description: string }>;
  tone_of_voice: {
    archetype: string;
    traits: string[];
    tone_test: string;
    reader_should_feel: string[];
    guidance: string;
  };
  personality: {
    thinks_like: string[];
    works_like: string[];
    communicates_like: string[];
    treats_clients_like: string[];
  };
  vocabulary: {
    core_language: Record<string, string[]>;
    preferred_verbs: string[];
    preferred_adjectives: string[];
    signature_phrases: string[];
    banned_flashy_words: string[];
    banned_identity_framings: string[];
    reconciliation_note: string;
  };
  sentence_formula: {
    structure: string;
    example_good: string;
    example_bad: string;
    test: string;
  };
  proof_points: {
    hierarchy: string[];
    measurable_outcomes: string[];
    track_record: string[];
    delivery_experience: string[];
    usage_rule: string;
  };
  confidentiality: {
    rule: string;
    never_name: string[];
    allowed_public_references: string[];
    anonymized_descriptors: string[];
    how_to_reference: string;
  };
  strategic_content_rules: string[];
  voice_examples: Array<{ context: string; text: string }>;
}

const BRAND_PATH = './data/brand.json';

let cached: BrandKnowledge | null = null;

export function getBrandKnowledge(): BrandKnowledge {
  if (cached) return cached;
  const brandPath = path.resolve(process.cwd(), BRAND_PATH);
  if (!existsSync(brandPath)) {
    throw new Error(
      `Brand knowledge file not found: ${brandPath}. ` +
      `Make sure data/brand.json is included in your Docker image or properly mounted.`
    );
  }
  cached = JSON.parse(readFileSync(brandPath, 'utf8')) as BrandKnowledge;
  return cached;
}

/**
 * Client/employer names covered by NDAs. Generated content must NEVER contain
 * these — the work is described anonymously instead (see brand.json
 * confidentiality.anonymized_descriptors). Checked deterministically by
 * postReviewer and the tier-2 refresh screen. "Microsoft Fluent UI" (public
 * open-source contribution) is the only whitelisted named project.
 */
export const CLIENT_NAME_BLOCKLIST = [
  'smashcloud',
  'dashcam',
  'replayable',
  'careford',
  'surgical extraction',
  'sermask',
  'teamcap',
];

/**
 * Words the brand bans that are safe to flag deterministically (they have no
 * legitimate use in our content). Checked by postReviewer's automated pass.
 * Words already on AI_VOCABULARY_BLOCKLIST (revolutionary, cutting-edge,
 * game-changer) are excluded here to avoid double penalties.
 */
export const BRAND_VOCABULARY_BLOCKLIST = [
  'disruptive',
  'world-class',
  'best-in-class',
  'bleeding-edge',
  'game-changing',
  'one-stop shop',
  'ninja',
  'rockstar',
  'guru',
  'code wizard',
];

/**
 * Fear-mongering phrasings the brand forbids. Deterministic screen: the brand
 * is a calm advisor, so money-scare metaphors are never legitimate in our
 * content. Checked by postReviewer's automated pass and the tier-2 refresh
 * script; any hit fails the content back to a rewrite.
 */
export const BRAND_FEAR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bbleed(?:ing|s)?\b/i, label: 'bleeding-money metaphor' },
  { pattern: /\bhemorrhag/i, label: 'hemorrhaging-money metaphor' },
  { pattern: /\b(?:ticking )?time bomb\b/i, label: 'time-bomb metaphor' },
  { pattern: /\bsilent(?:ly)? kill/i, label: 'silent-killer framing' },
  { pattern: /\bstop the (?:bleeding|damage)\b/i, label: 'stop-the-bleeding framing' },
  { pattern: /\bnightmare\b/i, label: 'nightmare framing' },
  { pattern: /\bdisaster waiting\b/i, label: 'impending-disaster framing' },
  { pattern: /\bhidden (?:secret|reason|truth)\b/i, label: 'clickbait hidden-X framing' },
];

const CASE_STUDIES_PATH = './data/case_studies.json';
let cachedCaseStudies: any | null = null;

function getCaseStudies(): any | null {
  if (cachedCaseStudies) return cachedCaseStudies;
  const p = path.resolve(process.cwd(), CASE_STUDIES_PATH);
  if (!existsSync(p)) return null;
  cachedCaseStudies = JSON.parse(readFileSync(p, 'utf8'));
  return cachedCaseStudies;
}

/**
 * Compact, NDA-safe evidence inventory for rewrite/realign prompts: the ONLY
 * client stories and numbers content may use. Injecting this is the structural
 * fix for fabrication — a model told "use only real proof" but not handed the
 * inventory will invent proof instead.
 */
export function getRealEvidenceBlock(): string {
  const cs = getCaseStudies();
  const b = getBrandKnowledge();
  if (!cs) return '';
  const lines = cs.case_studies.map((c: any) =>
    `- ${c.title} (${c.business_type}): ${c.evidence.join('; ')}`
  );
  const quotes = (cs.client_validation ?? []).slice(0, 3).map((v: any) => `- "${v.quote.slice(0, 140)}..." — ${v.attribution}`);
  return `REAL EVIDENCE INVENTORY — the ONLY specific claims, client stories, and numbers
permitted in the output. If a number, client, or outcome is not on this list, it must
NOT appear. Do not round up, combine, or "improve" these numbers. General advice needs
no numbers; an outcome without a number here is stated qualitatively ("features that
took weeks shipped in days").

${lines.join('\n')}

Public track record: ${cs.platform_track_record.facts.join('; ')}.
Client quotes available (attribute exactly as written):
${quotes.join('\n')}

Brand proof summary: ${b.proof_points.measurable_outcomes.join('; ')}.`;
}

/**
 * Numeric outcome claims (percentages / multipliers) that are backed by real
 * evidence. The tier-2 screen rejects any % or Nx claim not in this set —
 * deterministic fabrication detection.
 */
export function getAllowedNumericClaims(): Set<string> {
  const allowed = new Set<string>();
  const harvest = (text: string) => {
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) allowed.add(m[1]!);
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)x\b/gi)) allowed.add(`${m[1]}x`);
  };
  const cs = getCaseStudies();
  if (cs) {
    for (const c of cs.case_studies ?? []) for (const e of c.evidence ?? []) harvest(String(e));
    for (const f of cs.platform_track_record?.facts ?? []) harvest(String(f));
  }
  for (const o of getBrandKnowledge().proof_points.measurable_outcomes) harvest(o);
  return allowed;
}

/**
 * Full brand voice block for generation prompts (blogGeneration).
 * This is the highest-priority voice layer: where any other rule's example
 * wording conflicts with it, the brand tone wins.
 */
export function getBrandVoiceGuidelines(): string {
  const b = getBrandKnowledge();
  const pillars = b.messaging_pillars
    .map((p, i) => `${i + 1}. ${p.name} — ${p.description}`)
    .join('\n');
  const examples = b.voice_examples
    .map((e) => `- (${e.context}) "${e.text}"`)
    .join('\n');

  return `BRAND VOICE — HIGHEST-PRIORITY LAYER (overrides conflicting tone guidance elsewhere)

WHO IS WRITING: ${b.identity.brand_name}. ${b.identity.positioning}
After reading, the reader must think: "${b.identity.desired_perception}"
The transformation he sells: "${b.identity.transformation}"

CORE BELIEF: ${b.strategy.core_belief}
PHILOSOPHY: ${b.strategy.philosophy}

WHO WE WRITE FOR (get this wrong and the post is worthless):
${b.target_market.who_we_serve}
The buyer: ${b.target_market.buyer}
Engagement range: ${b.target_market.engagement_range}
Sweet-spot problems: ${b.target_market.sweet_spot_problems.join('; ')}
NOT our audience: ${b.target_market.who_we_do_not_target}

PROMISE ARCHITECTURE (non-negotiable):
${b.promise_architecture.rule}
We promise: ${b.promise_architecture.we_promise.join('; ')}
We NEVER promise: ${b.promise_architecture.we_never_promise.join('; ')}
Consequence framing: ${b.promise_architecture.consequence_framing}
Evidence vs promise: ${b.promise_architecture.evidence_vs_promise}

MESSAGING PILLARS (every post must reinforce at least one, naturally, not as slogans):
${pillars}

TONE: ${b.tone_of_voice.archetype}. ${b.tone_of_voice.traits.join(' | ')}
${b.tone_of_voice.guidance}
TONE TEST before finalizing any section: ${b.tone_of_voice.tone_test}
The reader should feel: ${b.tone_of_voice.reader_should_feel.join(', ')}.

SENTENCE FORMULA for important sentences: ${b.sentence_formula.structure}
Good: "${b.sentence_formula.example_good}"
Bad: "${b.sentence_formula.example_bad}"
Test: ${b.sentence_formula.test}

BRAND VOCABULARY:
- Preferred verbs (use instead of "build"): ${b.vocabulary.preferred_verbs.join(', ')}
- Preferred adjectives: ${b.vocabulary.preferred_adjectives.join(', ')}
- Signature phrases (weave in naturally where they fit, 1-2 per post maximum): ${b.vocabulary.signature_phrases.join(' | ')}
- BANNED flashy words (never use): ${b.vocabulary.banned_flashy_words.join(', ')}
- ${b.vocabulary.banned_identity_framings.join('\n- ')}
- Note: ${b.vocabulary.reconciliation_note}

PROOF DISCIPLINE: ${b.proof_points.usage_rule}
Real proof available (use only these, never invent): ${b.proof_points.measurable_outcomes.join('; ')}. Track record: ${b.proof_points.track_record.join('; ')}.

CLIENT CONFIDENTIALITY (NDA — hard rule, output is rejected on violation):
${b.confidentiality.rule}
NEVER write these names: ${b.confidentiality.never_name.join(', ')}.
The only named references allowed: ${b.confidentiality.allowed_public_references.join('; ')}.
Describe the work anonymously instead — approved descriptors:
${b.confidentiality.anonymized_descriptors.map((d) => `- ${d}`).join('\n')}
${b.confidentiality.how_to_reference}

STRATEGIC RULES:
${b.strategic_content_rules.map((r) => `- ${r}`).join('\n')}

VOICE CALIBRATION EXAMPLES (this is what on-brand sounds like):
${examples}

RECONCILING WITH CONVERSION RULES BELOW: Keep every required conversion element
(diagnostic sections, cost-of-inaction, specific CTAs, real numbers) but express
them in this brand voice. You are a calm senior advisor warning a client, not a
marketer scaring one. Urgency comes from honest, concrete stakes stated plainly.
Never use fear-mongering hype like "bleeding money" or "shocking truth". State
the real cost, the real risk, and the practical way out.`;
}

/**
 * Compact brand voice block for refresh / rescue / humanize / rewrite prompts
 * where the full block would crowd out the task instructions.
 */
export function getBrandVoiceSummary(): string {
  const b = getBrandKnowledge();
  return `BRAND VOICE (align all writing to this):
- Author positioning: ${b.identity.positioning}
- Audience: ${b.target_market.who_we_serve} Buyer: ${b.target_market.buyer} NOT our audience: ${b.target_market.who_we_do_not_target}
- Tone: ${b.tone_of_voice.archetype} — calm, clear, warm, honest, business-first, never flashy. ${b.tone_of_voice.tone_test}
- Promises: ${b.promise_architecture.rule} We NEVER promise: ${b.promise_architecture.we_never_promise.join('; ')}. ${b.promise_architecture.evidence_vs_promise}
- Consequences: ${b.promise_architecture.consequence_framing}
- Sentence formula: ${b.sentence_formula.structure}. Lead with the business problem or outcome; technology comes last.
- Messaging pillars to reinforce naturally: ${b.messaging_pillars.map((p) => p.name).join(' | ')}
- Never use: ${b.vocabulary.banned_flashy_words.join(', ')}. Never describe the author as a freelancer, coder, or programmer.
- NDA: NEVER name a client or employer (${b.confidentiality.never_name.join(', ')}). Describe the work anonymously: ${b.confidentiality.how_to_reference}
- Signature language (use sparingly where natural): ${b.vocabulary.signature_phrases.slice(0, 8).join(' | ')}`;
}
