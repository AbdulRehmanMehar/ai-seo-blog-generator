import type { BlogPostStructure } from '../prompts/blogGeneration.js';
import { CLIENT_NAME_BLOCKLIST, getAllowedNumericClaims } from '../knowledge/brandKnowledge.js';

/**
 * Brand redaction and screening — the deterministic layer of the brand system.
 * Shared by the tier-2 realign script (screen + input sanitization) and the
 * corpus-wide redaction sweep, so there is exactly ONE definition of what is
 * unshippable: fear idioms, payback/ROI promises, dollar-outcome claims,
 * NDA client names, fabricated numbers, and AI-tell formatting.
 */

export const BRAND_SCREEN: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bbleed(?:ing|s)?\b/i, label: 'bleeding-money metaphor' },
  { pattern: /\bhemorrhag/i, label: 'hemorrhaging metaphor' },
  { pattern: /\btime bomb\b/i, label: 'time-bomb metaphor' },
  { pattern: /\bsilent(?:ly)? kill/i, label: 'silent-killer framing' },
  { pattern: /\bnightmare\b/i, label: 'nightmare framing' },
  { pattern: /\bburn(?:ing)? (?:money|cash|runway)\b/i, label: 'burning-money metaphor' },
  { pattern: /\bstop the (?:bleeding|damage)\b/i, label: 'stop-the-bleeding framing' },
  { pattern: /\bsurviv(?:e|ing) this (?:one|quarter)\b/i, label: 'survival-panic framing' },
  { pattern: /\ba lot of money\b/i, label: 'vague money talk' },
  { pattern: /\bschedule a call\b/i, label: 'generic pressure CTA' },
  { pattern: /\bhidden (?:secret|reason|truth)\b/i, label: 'clickbait hidden-X framing' },
  { pattern: /\bpays? for itself\b/i, label: 'payback promise (we never promise ROI or payback)' },
  { pattern: /\bpayback period\b/i, label: 'payback promise (we never promise ROI or payback)' },
  { pattern: /\broi\b/i, label: 'ROI claim (we never promise ROI)' },
  { pattern: /\bsav(?:e|es|ing) you (?:roughly |about |around |up to )?\$\d/i, label: 'promised dollar savings' },
  { pattern: /\bwill save (?:roughly |about |around |up to )?\$\d/i, label: 'promised dollar savings' },
  { pattern: /\bcost(?:s|ing)? you (?:roughly |about |around |up to )?\$\d[\d,.]*\s*(?:k|m|million|thousand)?\s*(?:a|per|every) (?:year|month|week|day)\b/i, label: 'asserted dollar cost' },
  { pattern: /\byou(?:'re| are) (?:likely )?los(?:e|ing) (?:roughly |about |around |up to )?\$\d/i, label: 'asserted dollar loss' },
];

// Calibrated to what honest (no-fabrication) fresh rewrites actually produce; the
// index-rescue floor is 1,500 words and Google indexed those. Padding to 1,800 with
// filler would hurt more than 1,450 words of substance.
export const MIN_BODY_WORDS = 1400;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hasUnverifiedNumber(s: string, allowed: Set<string>): boolean {
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s?%/g)) if (!allowed.has(m[1]!)) return true;
  for (const m of s.matchAll(/\b(\d+(?:\.\d+)?)x\b/gi)) if (!allowed.has(`${m[1]}x`)) return true;
  for (const m of s.matchAll(/\b(\d+) times (?:faster|slower|more|better|higher|lower)\b/gi)) if (!allowed.has(`${m[1]}x`)) return true;
  return false;
}

/**
 * Strip screen-violating phrases from a post before it becomes an LLM prompt's
 * topic map. Models copy what they read: remove the anchor and the violation
 * stops recurring.
 */
export function sanitizeTopicMap(post: BlogPostStructure): BlogPostStructure {
  let str = JSON.stringify(post);
  for (const { pattern } of BRAND_SCREEN) {
    str = str.replace(new RegExp(pattern.source, 'gi'), '');
  }
  str = str.replace(/\bFID\b/g, 'INP'); // FID was replaced by INP in Core Web Vitals (2024)
  for (const name of CLIENT_NAME_BLOCKLIST) {
    str = str.replace(new RegExp(escapeRe(name), 'gi'), 'a client project');
  }
  const allowed = getAllowedNumericClaims();
  str = str.replace(/(\d+(?:\.\d+)?)\s?%/g, (m, n) => (allowed.has(n) ? m : ''));
  str = str.replace(/\b(\d+(?:\.\d+)?)x\b/gi, (m, n) => (allowed.has(`${n}x`) ? m : ''));
  return JSON.parse(str) as BlogPostStructure;
}

export interface RedactionStats {
  droppedSentences: string[];
  trimmedFaqs: number;
  cappedCtas: number;
}

/**
 * Delete whole sentences containing unshippable content (fear idioms, payback
 * promises, NDA names, unverified numbers), trim FAQ answers to budget, cap
 * mid-article CTAs at 3. Deterministic — no LLM involved.
 */
export function redactViolatingSentences(post: BlogPostStructure): { post: BlogPostStructure; stats: RedactionStats } {
  const allowed = getAllowedNumericClaims();
  const ndaRes = CLIENT_NAME_BLOCKLIST.map((n) => new RegExp(escapeRe(n), 'i'));
  const stats: RedactionStats = { droppedSentences: [], trimmedFaqs: 0, cappedCtas: 0 };

  const clean = (text: string | null | undefined): string | null => {
    if (typeof text !== 'string' || !text) return (text as string | null | undefined) ?? null;
    const sentences = text.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => {
      const ok = !BRAND_SCREEN.some(({ pattern }) => pattern.test(s)) && !hasUnverifiedNumber(s, allowed) && !ndaRes.some((re) => re.test(s));
      if (!ok) stats.droppedSentences.push(s.trim());
      return ok;
    });
    return kept.join(' ').trim() || text;
  };
  const trimAnswer = (answer: string): string => {
    if (typeof answer !== 'string') return answer;
    const sentences = answer.split(/(?<=[.!?])\s+/);
    let out = '';
    for (const s of sentences) {
      if (out && (out + ' ' + s).split(/\s+/).length > 25) break;
      out = out ? `${out} ${s}` : s;
    }
    if (out && out !== answer) stats.trimmedFaqs++;
    return out || answer;
  };
  let ctasKept = 0;
  const redacted: BlogPostStructure = {
    ...post,
    hero: post.hero ? { ...post.hero, hook: clean(post.hero.hook) ?? post.hero.hook, subtitle: clean(post.hero.subtitle) ?? post.hero.subtitle } : post.hero,
    sections: (post.sections ?? []).map((s) => {
      const cta = clean(s.cta);
      const keep = typeof cta === 'string' && cta.trim() ? ++ctasKept <= 3 : false;
      if (!keep && typeof cta === 'string' && cta.trim()) stats.cappedCtas++;
      return {
        ...s,
        content: clean(s.content) ?? s.content,
        keyTakeaway: clean(s.keyTakeaway),
        cta: keep ? cta : null,
      };
    }),
    faq: (post.faq ?? []).map((f) => ({ ...f, answer: trimAnswer(clean(f.answer) ?? f.answer) })),
    conclusion: post.conclusion
      ? { ...post.conclusion, summary: clean(post.conclusion.summary) ?? post.conclusion.summary }
      : post.conclusion,
  };
  return { post: redacted, stats };
}

/** Full deterministic screen — any hit means the post must not ship as-is. */
export function screenBrandViolations(post: BlogPostStructure, includeTitle: boolean): string[] {
  const body = [
    includeTitle ? post.title : null,
    includeTitle ? post.meta?.title : null,
    post.hero?.hook, post.hero?.subtitle,
    ...(post.sections ?? []).flatMap((s) => [s.heading, s.content, s.keyTakeaway, s.cta]),
    ...(post.faq ?? []).flatMap((f) => [f.question, f.answer]),
    post.conclusion?.summary, post.conclusion?.cta?.text, post.conclusion?.cta?.buttonText,
  ].filter(Boolean).join(' ');
  const hits: string[] = [];
  for (const { pattern, label } of BRAND_SCREEN) {
    const m = body.match(pattern);
    if (m) hits.push(`${label} ("${m[0]}")`);
  }
  for (const name of CLIENT_NAME_BLOCKLIST) {
    const m = body.match(new RegExp(escapeRe(name), 'i'));
    if (m) hits.push(`NDA client name ("${m[0]}") — describe the work anonymously, never name the client`);
  }

  const metaText = `${post.meta?.title ?? ''} ${post.meta?.description ?? ''}`;
  if (/[—–]/.test(body) || /[—–]/.test(metaText)) {
    hits.push('em/en dash found (AI-detection tell) — replace with a period, comma, or "and"');
  }

  const allowed = getAllowedNumericClaims();
  const numericClaims = [
    ...body.matchAll(/(\d+(?:\.\d+)?)\s*%/g),
    ...body.matchAll(/\b(\d+(?:\.\d+)?)x\b/gi),
    ...body.matchAll(/\b(\d+) times (?:faster|slower|more|better|higher|lower)\b/gi),
  ];
  const badClaims = new Set<string>();
  for (const m of numericClaims) {
    const token = m[0]!.toLowerCase().replace(/\s+/g, '');
    const key = /x$/.test(token) || /times/.test(m[0]!.toLowerCase()) ? `${m[1]}x` : m[1]!;
    if (!allowed.has(key)) badClaims.add(m[0]!.trim());
  }
  for (const c of badClaims) {
    hits.push(`unverified numeric claim ("${c}") — only numbers from the real evidence inventory may appear; remove it or state the outcome qualitatively`);
  }

  if (/\bFID\b/.test(body) && !/\bINP\b/.test(body)) {
    hits.push('teaches deprecated metric FID as current — Core Web Vitals are LCP, INP, CLS (INP replaced FID in 2024); update every FID mention');
  }

  const ctaCount = (post.sections ?? []).filter((s) => s.cta && s.cta.trim()).length;
  if (ctaCount > 3) hits.push(`too many CTAs (${ctaCount} mid-article; maximum 3 — set "cta": null on the rest)`);

  for (const f of post.faq ?? []) {
    const w = f.answer.split(/\s+/).length;
    if (w > 35) hits.push(`FAQ answer too long (${w} words: "${f.question.slice(0, 50)}") — cut to 25 words`);
  }

  const words = body.split(/\s+/).length;
  if (words < MIN_BODY_WORDS) {
    hits.push(`too thin (${words} words; expand every section with genuine substance to reach at least 1,800 total)`);
  }
  return hits;
}
