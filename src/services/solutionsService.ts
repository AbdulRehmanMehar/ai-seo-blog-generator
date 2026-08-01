import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { GeminiClient } from '../llm/geminiClient.js';
import { safeJsonParse } from '../utils/json.js';
import { KeywordService, type DiscoveredKeyword } from './keywordService.js';
import { WebsiteService, type VoicePerspective } from './websiteService.js';
import { getIcpByName } from '../knowledge/icpKnowledge.js';
import { getAllowedNumericClaims, getCaseStudiesForNiche, CLIENT_NAME_BLOCKLIST, BRAND_VOCABULARY_BLOCKLIST, BRAND_FEAR_PATTERNS } from '../knowledge/brandKnowledge.js';
import { AI_VOCABULARY_BLOCKLIST } from '../prompts/reviewer.js';
import { VOCABULARY_REPLACEMENTS } from './postHumanizer.js';
import { solutionsPageContentPrompt, servicePageContentPrompt, type SeoKeywordCandidate, type SerpFinding } from '../prompts/solutions.js';
import { reviewSolutionContent, type SolutionsReviewResult } from './solutionsReviewer.js';
import { SOLUTIONS_PASS_THRESHOLD } from '../prompts/solutionsReviewer.js';
import { postgresPool } from '../db/postgresPool.js';
import { SolutionEmbeddingStore } from '../embeddings/solutionEmbeddingStore.js';

export interface SolutionsServiceDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
}

/**
 * Per-service natural search phrases used to build seed keywords, keyed by
 * services.slug. Deliberately NOT "{niche} software" / "{niche} automation" bare
 * category terms — a live SERP check (2026-08-01) showed those surface SaaS
 * shopping-comparison intent: page 1 for "staffing management software" was
 * Bullhorn's own site, Wikipedia, and three "10 Best Staffing Software" listicle
 * sites. That's unwinnable for a new page and the wrong customer intent for a
 * services page (people typing it want to compare software to buy, not hire
 * someone to build a custom fix). These phrases target hiring/problem intent.
 */
const SERVICE_SEARCH_MODIFIERS: Record<string, string[]> = {
  'booking-scheduling-intake': [
    'intake automation', 'appointment scheduling automation', 'online booking system developer',
    'booking system integration', 'intake form automation'
  ],
  'systems-integration': [
    'ats integration', 'software integration consultant', 'api integration developer',
    'system integration service', 'crm integration developer'
  ],
  'workflow-ai-automation': [
    'workflow automation consultant', 'business process automation service', 'ai automation developer',
    'workflow automation service', 'ai assistant developer'
  ],
  'website-web-app-modernization': [
    'website redesign developer', 'web app modernization', 'legacy website rebuild',
    'website rebuild service', 'web app developer'
  ],
  'customer-portals-dashboards': [
    'custom client portal developer', 'internal dashboard developer', 'custom software developer',
    'client portal development', 'dashboard development service'
  ]
};

/**
 * Domains that show up almost exclusively for software-comparison-shopping searches,
 * not hiring searches. Deliberately excludes Wikipedia and Gartner (2026-08-01) — a
 * generic reference/analyst-report result on page 1 doesn't mean the SERP is a
 * comparison-shopping page the way a G2/Capterra listing does, and including them was
 * flagging almost every established SaaS-category keyword as shopping intent, leaving
 * bare-category seeds (the only ones with real measurable volume — see researchNicheSeo)
 * with nowhere to land.
 */
const SHOPPING_INTENT_DOMAINS = new Set([
  'g2.com', 'capterra.com', 'softwareadvice.com', 'getapp.com',
  'trustradius.com', 'financesonline.com'
]);
const LISTICLE_TITLE_RE = /\bbest\b|\btop\s*\d+\b|\d+\s+best\b|\bvs\.?\b|\breview(s|ed)?\b/i;

/**
 * True if a SERP reads as a software-shopping/comparison page rather than a
 * hiring/service query — at least 3 of the checked results are a known review
 * aggregator or a "best/top N" style listicle title. Raised from 2 to 3
 * (2026-08-01, live full-matrix test) — at 2, this rejected nearly every
 * candidate with real search volume across every service tested, since any
 * established SaaS category SERP has at least a couple of these mixed in.
 */
function looksLikeShoppingIntent(top: Array<{ domain: string; title: string }>): boolean {
  if (top.length === 0) return false;
  const hits = top.filter(
    (t) => SHOPPING_INTENT_DOMAINS.has(t.domain.toLowerCase()) || LISTICLE_TITLE_RE.test(t.title)
  );
  return hits.length >= 3;
}

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** 2-4 consecutive Title-Case words in a result title, diacritic- and case-normalized. */
function extractTitlePhrases(title: string): Set<string> {
  const matches = title.match(/\b[A-Z][a-zA-Zà-öø-ÿÀ-ÖØ-ß'-]+(?:\s+[A-Z][a-zA-Zà-öø-ÿÀ-ÖØ-ß'-]+){1,3}\b/g) ?? [];
  return new Set(matches.map((m) => stripDiacritics(m).toLowerCase()));
}

/**
 * True if one distinct multi-word phrase (a company/brand name, or the vendor's
 * own product name) repeats across at least half the checked results — signals
 * a navigational/brand-collision SERP, not genuine hiring-intent diversity.
 * Found via a live check (2026-08-01): "automation temp agency" (880/mo) looked
 * like a clean hiring-intent term, but every result was the literal company
 * "Automation Personnel Services" (Birmingham/Memphis/Baton Rouge/Decatur/
 * Dalton listings, Facebook, Yelp, Instagram) — a real business whose name
 * happens to contain the query, not businesses searching to automate their own
 * agency. Same pattern for "avionté staffing software": avionte.com, its
 * LinkedIn, its Glassdoor, its ZoomInfo — all one vendor's own presence.
 */
function looksLikeBrandDominatedSerp(top: Array<{ domain: string; title: string }>): boolean {
  if (top.length < 3) return false;
  const phraseCounts = new Map<string, number>();
  for (const t of top) {
    for (const phrase of extractTitlePhrases(t.title)) {
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
  }
  const threshold = Math.ceil(top.length / 2);
  for (const count of phraseCounts.values()) {
    if (count >= threshold) return true;
  }
  return false;
}

const SERVICE_STOPWORDS = new Set([
  'for', 'a', 'an', 'the', 'and', 'service', 'services', 'solutions', 'system', 'systems', 'software'
]);

/**
 * True if a keyword idea has zero token overlap with the service's own vocabulary
 * (its name + its search modifiers) — a real bug found live (2026-08-01): the
 * Hospitality x Booking-Scheduling-Intake page's headline drifted into "cloud
 * based pos systems for restaurants" (a real, hiring-adjacent, non-shopping-intent
 * keyword — it correctly passed both filters above) because DataForSEO's semantic
 * expansion off "hospitality software"/"hospitality automation" seed phrases
 * wandered into an adjacent product category (restaurant POS terminals) that
 * this brand doesn't sell. Catching this via SERP-intent alone isn't possible —
 * the SERP for that keyword is genuinely a hiring-adjacent market, just for a
 * different service. A cheap token-overlap check catches it before the bad
 * keyword ever reaches the generation prompt.
 */
function looksTopicallyUnrelated(keyword: string, serviceName: string, serviceSlug?: string): boolean {
  const modifiers = (serviceSlug ? SERVICE_SEARCH_MODIFIERS[serviceSlug] : undefined) ?? [];
  const serviceTokens = new Set(
    (`${serviceName} ${modifiers.join(' ')}`.toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => !SERVICE_STOPWORDS.has(t))
  );
  const keywordTokens = (keyword.toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => !SERVICE_STOPWORDS.has(t));
  return !keywordTokens.some((t) => serviceTokens.has(t));
}

/** Fields where pricing must never appear — they can render as raw SERP snippets, unlike an FAQ answer on the page itself. */
const NO_PRICE_FIELDS = ['headline', 'subheadline', 'cta', 'meta_title', 'meta_description'] as const;
const DOLLAR_FIGURE_RE = /\$\s?\d[\d,]*k?/i;

/**
 * Mechanically correct plural-to-singular pronoun slips on a solo-founder page,
 * the same way postHumanizer.ts fixes mechanical AI-tell patterns rather than
 * rejecting and re-generating the whole page over a fixable word choice. A live
 * test (2026-08-01) showed the prompt instruction alone doesn't reliably stop
 * the model from writing "we" — rejecting outright wasted a good generation over
 * a handful of words. Present tense verbs don't change between I/we in English
 * (only "to be" does), so this swap is grammatically safe.
 */
/**
 * Split text into quoted and unquoted segments. Client quotes are the CLIENT
 * speaking ("we've gone back to Abdul for the third time"), so "we" inside a
 * quote refers to the client's company, not the brand — and the evidence rules
 * require quotes attributed exactly as written. Both the mechanical pronoun
 * swap and the pronoun-mismatch screen must leave quoted spans alone (found
 * live 2026-08-01: the we→I swap rewrote a real client quote). Word-internal
 * apostrophes (we've, client's) never open or close a span; an unterminated
 * quote falls back to unquoted so the fixes still apply.
 */
function splitQuotedSegments(text: string): Array<{ text: string; quoted: boolean }> {
  const segments: Array<{ text: string; quoted: boolean }> = [];
  let current = '';
  let quoteChar: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const prev = i > 0 ? text[i - 1]! : '';
    const next = i + 1 < text.length ? text[i + 1]! : '';
    const isQuoteChar = ch === "'" || ch === '"';
    const wordInternal = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next);
    if (isQuoteChar && !wordInternal) {
      if (quoteChar === null && (prev === '' || /[\s([{,:;]/.test(prev))) {
        if (current) segments.push({ text: current, quoted: false });
        current = ch;
        quoteChar = ch;
        continue;
      }
      if (quoteChar === ch) {
        current += ch;
        segments.push({ text: current, quoted: true });
        current = '';
        quoteChar = null;
        continue;
      }
    }
    current += ch;
  }
  if (current) segments.push({ text: current, quoted: false });
  return segments;
}

/** The text visible OUTSIDE client quotes — what brand-voice pronoun rules actually govern. */
function textOutsideQuotes(text: string): string {
  return splitQuotedSegments(text).filter((s) => !s.quoted).map((s) => s.text).join(' ');
}

function fixSingularPronounsRaw(text: string): string {
  return text
    .replace(/\bwe're\b/gi, "I'm")
    .replace(/\bwe'll\b/gi, "I'll")
    .replace(/\bwe've\b/gi, "I've")
    .replace(/\bwe are\b/gi, (m) => (m[0] === m[0]!.toUpperCase() ? 'I am' : 'i am'))
    .replace(/\bwe were\b/gi, (m) => (m[0] === m[0]!.toUpperCase() ? 'I was' : 'i was'))
    .replace(/\bwe\b/gi, 'I')
    .replace(/\bours\b/gi, (m) => (m[0] === m[0]!.toUpperCase() ? 'Mine' : 'mine'))
    .replace(/\bour\b/gi, (m) => (m[0] === m[0]!.toUpperCase() ? 'My' : 'my'))
    .replace(/\bus\b/gi, (m) => (m[0] === m[0]!.toUpperCase() ? 'Me' : 'me'));
}

function fixSingularPronouns(text: string): string {
  return splitQuotedSegments(text)
    .map((s) => (s.quoted ? s.text : fixSingularPronounsRaw(s.text)))
    .join('');
}

/**
 * Mechanically swap AI-tell vocabulary for natural alternatives, reusing
 * postHumanizer.ts's exact replacement map — the same fix-not-reject pattern as
 * fixSingularPronouns above. A live test (2026-08-01) showed the prompt's "don't
 * use these words" instruction alone doesn't reliably stop the model (it used
 * "optimized"), and blog posts don't reject over this either; postHumanizer just
 * swaps the word out.
 */
function fixAiVocabulary(text: string): string {
  let result = text;
  for (const [word, replacements] of Object.entries(VOCABULARY_REPLACEMENTS)) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    if (regex.test(result)) {
      const replacement = replacements[Math.floor(Math.random() * replacements.length)] ?? replacements[0] ?? word;
      result = result.replace(regex, (match: string) =>
        match[0] === match[0]!.toUpperCase() ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement
      );
    }
  }
  return result;
}

const solutionsContentSchema = z.object({
  headline: z.string().min(1),
  subheadline: z.string().min(1),
  pain_points: z.array(z.string().min(1)).min(3).max(6),
  approach: z.array(z.object({ step: z.string().min(1), description: z.string().min(1) })).min(3).max(6),
  proof_points: z.array(z.string().min(1)).min(1).max(6),
  faq: z.array(z.object({ question: z.string().min(1), answer: z.string().min(1) })).min(3).max(6),
  cta: z.string().min(1),
  meta_title: z.string().min(1),
  meta_description: z.string().min(1)
});

export type SolutionsPageContent = z.infer<typeof solutionsContentSchema>;

export interface ServiceRow {
  id: string;
  websiteId: string;
  name: string;
  slug: string;
  shortPitch: string | null;
}

export interface NicheRow {
  id: string;
  websiteId: string;
  name: string;
  slug: string;
  defaultIcpName: string | null;
  status: string;
}

export interface SolutionReviewRow {
  id: string;
  headline: string;
  aiReviewScore: number | null;
  aiReviewPassed: boolean | null;
  reviewedBy: string | null;
  serviceName: string;
  serviceSlug: string;
  nicheName: string;
  nicheSlug: string;
  wordCount: number;
}

export interface NicheSeoResearch {
  /**
   * Every keyword idea with real measured volume, BEFORE the shopping-intent
   * filter. Proves real search interest exists in this problem space, even when
   * every idea is a bare category/shopping term (e.g. "staffing agency
   * software"). Used as market-interest CONTEXT only — never as a literal
   * on-page target, since a full-grid scan (2026-08-01) showed only ~10% of
   * service x niche pairs ever produce a genuinely hiring-intent, non-shopping
   * candidate. Gates generation: empty means no evidence this topic is
   * searched at all, and generation is refused.
   */
  marketSignal: SeoKeywordCandidate[];
  /**
   * The subset of marketSignal whose SERP does NOT read as software-shopping
   * intent (see looksLikeShoppingIntent) — safe to feature verbatim in the
   * headline/meta_title. Usually empty; when present, the prompt targets it
   * directly instead of relying on internal links alone.
   */
  onPageCandidates: SeoKeywordCandidate[];
  serpFindings: SerpFinding[];
}

/**
 * The CTA's destination is always the site's own real contact/lead-capture page —
 * lead capture and tracking live entirely outside this pipeline, so this function
 * never invents a URL, only appends UTM attribution to the site's existing one.
 * Built with the URL API (not string concatenation) so query params land before
 * an existing hash fragment (e.g. ".../#contact") rather than after it, which
 * would silently make them invisible to anything reading location.search.
 */
function buildSolutionCtaUrl(defaultCtaUrl: string | null, serviceSlug: string, nicheSlug: string): string | null {
  if (!defaultCtaUrl) return null;
  try {
    const url = new URL(defaultCtaUrl);
    url.searchParams.set('utm_source', 'solutions_page');
    url.searchParams.set('utm_medium', 'website');
    url.searchParams.set('utm_campaign', `${serviceSlug}_${nicheSlug}`);
    return url.toString();
  } catch {
    return defaultCtaUrl;
  }
}

export class SolutionsService {
  private readonly websiteService: WebsiteService;
  private readonly keywordService: KeywordService;
  private readonly solutionEmbeddings: SolutionEmbeddingStore;

  constructor(private readonly deps: SolutionsServiceDeps) {
    this.websiteService = new WebsiteService(deps.pool);
    this.keywordService = new KeywordService({ pool: deps.pool, gemini: deps.gemini });
    this.solutionEmbeddings = new SolutionEmbeddingStore(postgresPool);
  }

  async listServices(websiteId: string): Promise<ServiceRow[]> {
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, website_id, name, slug, short_pitch FROM services WHERE website_id = ? ORDER BY name`,
      [websiteId]
    );
    return (rows as any[]).map((r) => ({
      id: String(r.id), websiteId: String(r.website_id), name: String(r.name),
      slug: String(r.slug), shortPitch: r.short_pitch ?? null
    }));
  }

  async listNiches(websiteId: string, status: 'approved' | 'proposed' | 'rejected' = 'approved'): Promise<NicheRow[]> {
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, website_id, name, slug, default_icp_name, status FROM niches WHERE website_id = ? AND status = ? ORDER BY name`,
      [websiteId, status]
    );
    return (rows as any[]).map((r) => ({
      id: String(r.id), websiteId: String(r.website_id), name: String(r.name),
      slug: String(r.slug), defaultIcpName: r.default_icp_name ?? null, status: String(r.status)
    }));
  }

  /**
   * RETIRED from the generation flow (2026-08-01) and locked behind
   * env.SOLUTIONS_SEO_RESEARCH_ENABLED (default false): a live full-matrix test
   * proved this research structurally can't ground these pages — every
   * niche-qualified phrasing measured zero Ads volume, and every measurable
   * category term was shopping-intent (G2/Capterra-dominated SERPs) or
   * brand-collision. The proof gate (case_studies.json niche_fit) +
   * retroactive GSC validation replaced it. Kept, flag-gated, only for ad-hoc
   * diagnostic use — generateSolutionContent no longer calls it, and the hard
   * throw below guarantees no future code path silently re-introduces paid
   * DataForSEO spend for solutions pages.
   */
  async researchNicheSeo(serviceName: string, nicheName: string, serviceSlug?: string): Promise<NicheSeoResearch> {
    if (!env.SOLUTIONS_SEO_RESEARCH_ENABLED) {
      throw new Error(
        'SolutionsService.researchNicheSeo is disabled: solutions pages no longer use DataForSEO ' +
        '(proof gate + GSC validation replaced it, 2026-08-01). Set SOLUTIONS_SEO_RESEARCH_ENABLED=true ' +
        'to deliberately re-enable paid research for a one-off diagnostic.'
      );
    }
    const modifiers: string[] = (serviceSlug ? SERVICE_SEARCH_MODIFIERS[serviceSlug] : undefined) ?? [serviceName.toLowerCase()];
    const nicheLower = nicheName.toLowerCase();
    const lengthFilter = (s: string) => s.split(' ').length <= 9 && s.length <= 75;

    // Bare category seeds — deliberately kept even though they skew shopping-intent.
    // marketSignal now gates generation on "is this problem space searched at all,"
    // and a full-grid scan (2026-08-01) showed niches with real category-level demand
    // (e.g. "staffing agency software") often have ZERO volume on any hiring-intent
    // phrasing — without these, that real signal would be invisible to the gate.
    // 5 modifiers x 3 patterns = 15 + 3 bare = 18 seeds, kept at the 20/chunk
    // DataForSEO limit deliberately (2026-08-01 cost review) — one extra seed over 20
    // forces a second $0.09 keywords_for_keywords task. Dropped the
    // "{niche} {modifier} service" pattern as the most redundant of the four —
    // "hire a {modifier} for {niche}" already carries the service/hiring framing.
    const bareSeeds = [
        `${nicheName} software`,
        `${nicheName} automation`,
        `${nicheName} ${serviceName}`,
        ...modifiers.flatMap((m) => [
          `${nicheName} ${m}`,
          `${m} for ${nicheName}`,
          `hire a ${m} for ${nicheLower}`
        ])
      ].filter(lengthFilter);

    // Pain-point seeds (2026-08-01) — mirror the framing that's actually proven to work
    // in the live blog corpus ("your off-the-shelf CRM is slowing you down", "why
    // off-the-shelf workflow software fails service businesses"), instead of only
    // trying bare category names. Run as their OWN DataForSEO task rather than mixed
    // into bareSeeds — a live test showed that when merged into one pool, these ideas
    // (being inherently lower-volume than an established SaaS-category term) never
    // survive a combined volume sort against something like "property management
    // software" at 18,100/mo, so they'd never even reach a SERP check. Isolating them
    // costs a second $0.09 keywords_for_keywords task, but guarantees they're
    // evaluated on their own merits instead of losing every volume tiebreak.
    const painPointSeeds = [
        `${nicheLower} outgrowing off the shelf software`,
        `${nicheLower} off the shelf software problems`
      ].filter(lengthFilter);

    const [bareIdeasRaw, painPointIdeasRaw] = await Promise.all([
      this.keywordService.dataForSeoKeywordsForKeywords(bareSeeds),
      painPointSeeds.length > 0 ? this.keywordService.dataForSeoKeywordsForKeywords(painPointSeeds) : Promise.resolve([])
    ]);

    const toRanked = (ideas: DiscoveredKeyword[]): SeoKeywordCandidate[] =>
      ideas
        .filter((k) => (k.volume ?? 0) > 0)
        .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        .map((k) => ({ keyword: k.keyword, volume: k.volume, cpc: k.cpc, difficulty: k.difficulty }));

    const rankedIdeas = toRanked(bareIdeasRaw);
    const painPointRankedIdeas = toRanked(painPointIdeasRaw);

    const marketSignal = [...rankedIdeas, ...painPointRankedIdeas]
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 10);

    const onPageCandidates: SeoKeywordCandidate[] = [];
    const serpFindings: SerpFinding[] = [];

    const checkCandidate = async (k: SeoKeywordCandidate): Promise<void> => {
      try {
        const top = await this.keywordService.dataForSeoSerpTop(k.keyword);
        serpFindings.push({ keyword: k.keyword, top });
        if (looksLikeShoppingIntent(top)) {
          // eslint-disable-next-line no-console
          console.log(
            `[SolutionsService] ⤫ "${k.keyword}" (${k.volume}/mo) reads as software-shopping intent — kept as market signal only, not an on-page target`
          );
          return;
        }
        if (looksLikeBrandDominatedSerp(top)) {
          // eslint-disable-next-line no-console
          console.log(
            `[SolutionsService] ⤫ "${k.keyword}" (${k.volume}/mo) reads as a navigational/brand-collision query (one company/product dominates page 1) — kept as market signal only, not an on-page target`
          );
          return;
        }
        if (looksTopicallyUnrelated(k.keyword, serviceName, serviceSlug)) {
          // eslint-disable-next-line no-console
          console.log(
            `[SolutionsService] ⤫ "${k.keyword}" (${k.volume}/mo) has no vocabulary overlap with "${serviceName}" — likely a different product category, kept as market signal only, not an on-page target`
          );
          return;
        }
        onPageCandidates.push(k);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`[SolutionsService] ⚠️ SERP lookup failed for "${k.keyword}": ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const INITIAL_CHECK_COUNT = 8;
    for (const k of rankedIdeas.slice(0, INITIAL_CHECK_COUNT)) {
      await checkCandidate(k);
    }

    // High-volume keyword ideas are disproportionately likely to be exactly the
    // broad/competitive/off-topic terms the filters above reject (2026-08-01: this
    // is precisely why two live pages ended up with zero on-page candidates —
    // every one of their top 8 by volume was shopping-intent or off-topic). If
    // the initial batch found nothing, keep checking further down the
    // volume-ranked list — lower-volume, less-competitive, more specific phrases
    // live there — up to a hard cap so a doomed pairing doesn't rack up unbounded
    // DataForSEO SERP cost.
    const EXTENDED_CHECK_COUNT = 20;
    if (onPageCandidates.length === 0 && rankedIdeas.length > INITIAL_CHECK_COUNT) {
      // eslint-disable-next-line no-console
      console.log(
        `[SolutionsService] ⚠️ no clean on-page keyword in the top ${INITIAL_CHECK_COUNT} by volume — extending search to #${Math.min(EXTENDED_CHECK_COUNT, rankedIdeas.length)}...`
      );
      for (const k of rankedIdeas.slice(INITIAL_CHECK_COUNT, EXTENDED_CHECK_COUNT)) {
        if (onPageCandidates.length > 0) break;
        await checkCandidate(k);
      }
    }

    // Bare-category ideas exhausted with nothing clean — give the pain-point-sourced
    // ideas (fetched separately so they can't lose a volume tiebreak, see above) their
    // own guaranteed check. Checked regardless of volume, since the whole point of this
    // pool is that it's real but inherently smaller-volume than a saturated category term.
    if (onPageCandidates.length === 0 && painPointRankedIdeas.length > 0) {
      const alreadyChecked = new Set(serpFindings.map((f) => f.keyword.toLowerCase()));
      const toCheck = painPointRankedIdeas.filter((k) => !alreadyChecked.has(k.keyword.toLowerCase()));
      if (toCheck.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[SolutionsService] ⚠️ still nothing clean — checking ${toCheck.length} pain-point-sourced candidate(s)...`);
        for (const k of toCheck) {
          if (onPageCandidates.length > 0) break;
          await checkCandidate(k);
        }
      }
    }

    return { marketSignal, onPageCandidates, serpFindings };
  }

  /**
   * Generate (or regenerate) draft content for one service x niche pair.
   * Fails closed: refuses to write a row if no real case study matches the
   * niche (the proof gate), or if the model's output cites a numeric claim
   * outside the approved evidence inventory, or names an NDA-covered client.
   * Costs Gemini calls only — never touches DataForSEO.
   */
  async generateSolutionContent(serviceId: string, nicheId: string, opts?: { force?: boolean }): Promise<boolean> {
    if (!env.SOLUTIONS_GENERATION_ENABLED) {
      // eslint-disable-next-line no-console
      console.log(
        '[SolutionsService] ⏸ solutions generation is disabled (the curated matrix is fully written and published, 2026-08-01). ' +
        'Set SOLUTIONS_GENERATION_ENABLED=true to re-enable when new case studies or niches justify new pages.'
      );
      return false;
    }
    const [[serviceRow]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, website_id, name, slug, short_pitch FROM services WHERE id = ?`,
      [serviceId]
    );
    const [[nicheRow]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, website_id, name, slug, default_icp_name FROM niches WHERE id = ?`,
      [nicheId]
    );
    if (!serviceRow || !nicheRow) return false;
    const service = serviceRow as any;
    const niche = nicheRow as any;
    if (service.website_id !== niche.website_id) return false;

    const website = await this.websiteService.getById(String(service.website_id));
    if (!website) return false;

    // Look up any existing row for this pair up front so a regeneration reuses its id
    // (rather than generating a throwaway one) and excludes its own prior embedding
    // from the near-duplicate check below — comparing new content against its own
    // last version isn't the point, only against OTHER niches under this service.
    const [[existingRow]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, status, reviewed_by FROM solutions WHERE service_id = ? AND niche_id = ?`,
      [serviceId, nicheId]
    );
    const existingId = existingRow ? String((existingRow as any).id) : null;

    // A published or human-reviewed row must never be silently overwritten by a
    // regeneration — once approve/publish exist, an ON DUPLICATE KEY UPDATE here would
    // otherwise change live, signed-off content while the row still claims to be
    // reviewed/published for text nobody actually looked at.
    if (existingRow && (existingRow.status === 'published' || existingRow.reviewed_by) && !opts?.force) {
      // eslint-disable-next-line no-console
      console.log(
        `[SolutionsService] ⚠️ refusing to regenerate "${service.name}" x "${niche.name}": already ${existingRow.status}` +
        `${existingRow.reviewed_by ? ` and reviewed by ${existingRow.reviewed_by}` : ''} — pass { force: true } to override and re-queue for review`
      );
      return false;
    }

    // ── PROOF GATE (2026-08-01, replaces the retired DataForSEO keyword gate) ──
    // A niche page only generates when at least one real, curated case study
    // matches this niche (data/case_studies.json niche_fit). This is what keeps
    // the service x niche matrix from producing thin doorway pages: every
    // published niche page carries a genuine story from that industry. Pairs
    // without proof belong as a section on the service-level page instead.
    // Free, deterministic, auditable — no API call of any kind.
    const matchedCaseStudies = getCaseStudiesForNiche(String(niche.slug));
    if (matchedCaseStudies.length === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[SolutionsService] ⚠️ skipping "${service.name}" x "${niche.name}": no real case study matches this niche ` +
        `(case_studies.json niche_fit) — a niche page without industry proof would be a doorway page. ` +
        `This niche is covered by the service-level page instead.`
      );
      return false;
    }

    const icp = niche.default_icp_name ? await getIcpByName(String(niche.default_icp_name)) : undefined;

    const loop = await this.runPageQualityLoop({
      buildPrompt: (retryFeedback) => solutionsPageContentPrompt({
        serviceName: String(service.name),
        servicePitch: service.short_pitch ?? null,
        nicheName: String(niche.name),
        websiteDomain: website.domain,
        brandName: website.brandName,
        icp: icp ?? null,
        matchedCaseStudies,
        defaultCtaText: website.defaultCtaText,
        defaultCtaUrl: website.defaultCtaUrl,
        voicePerspective: website.voicePerspective,
        retryFeedback
      }),
      voicePerspective: website.voicePerspective,
      serviceName: String(service.name),
      reviewNicheLabel: String(niche.name),
      logLabel: `"${service.name}" x "${niche.name}"`
    });
    if (loop.hardRejected || !loop.finalContent) return false;
    const { finalContent, lastReview, qualityGateExhausted } = loop;

    // Near-duplicate check + embedding upsert only run on a genuine pass. Running them
    // on an exhausted-quality-gate row would let a weak/templatey draft's embedding sit
    // in solution_embeddings and falsely flag a LATER, genuinely good attempt at a
    // different niche (same service) as "too similar to the bad one." approveSolution()
    // recomputes and upserts the embedding when a human vouches for an override instead.
    let embedding: number[] | null = null;
    if (!qualityGateExhausted) {
      const embeddingText = `${finalContent.headline}\n${finalContent.subheadline}\n${finalContent.pain_points.join(' ')}`;
      embedding = await this.deps.gemini.embedText(embeddingText);
      const sim = await this.solutionEmbeddings.bestSimilarityForService({ embedding, serviceId, excludeId: existingId });
      if (sim.best >= env.SOLUTIONS_DUPLICATE_SIMILARITY_THRESHOLD) {
        let collidingNiche = sim.bestId ?? 'unknown';
        if (sim.bestId) {
          const [[collidingRow]] = await this.deps.pool.query<RowDataPacket[]>(
            `SELECT n.name AS niche_name FROM solutions s JOIN niches n ON n.id = s.niche_id WHERE s.id = ?`,
            [sim.bestId]
          );
          if (collidingRow) collidingNiche = String((collidingRow as any).niche_name);
        }
        // eslint-disable-next-line no-console
        console.log(
          `[SolutionsService] ⚠️ rejected "${service.name}" x "${niche.name}": too similar (${sim.best.toFixed(3)}) ` +
          `to the "${collidingNiche}" page for the same service`
        );
        return false;
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[SolutionsService] ⚠️ "${service.name}" x "${niche.name}" exhausted all attempts without clearing the ` +
        `quality gate (last score: ${lastReview?.score ?? 'n/a'}/100) — storing as draft for human review rather than discarding`
      );
    }

    const id = existingId ?? crypto.randomUUID();
    const ctaUrl = buildSolutionCtaUrl(website.defaultCtaUrl, String(service.slug), String(niche.slug));
    await this.deps.pool.query<ResultSetHeader>(
      `INSERT INTO solutions (
         id, website_id, service_id, niche_id, headline, subheadline,
         pain_points_json, approach_json, proof_points_json, faq_json, cta_text, cta_url,
         target_keywords_json, meta_title, meta_description,
         ai_review_score, ai_review_passed, ai_review_issues_json, ai_reviewed_at,
         status, generated_by, content_generated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'draft', 'ai', NOW())
       ON DUPLICATE KEY UPDATE
         headline = VALUES(headline), subheadline = VALUES(subheadline),
         pain_points_json = VALUES(pain_points_json), approach_json = VALUES(approach_json),
         proof_points_json = VALUES(proof_points_json), faq_json = VALUES(faq_json),
         cta_text = VALUES(cta_text), cta_url = VALUES(cta_url),
         target_keywords_json = VALUES(target_keywords_json),
         meta_title = VALUES(meta_title), meta_description = VALUES(meta_description),
         ai_review_score = VALUES(ai_review_score), ai_review_passed = VALUES(ai_review_passed),
         ai_review_issues_json = VALUES(ai_review_issues_json), ai_reviewed_at = NOW(),
         status = 'draft', reviewed_by = NULL, reviewed_at = NULL,
         content_generated_at = NOW()`,
      [
        id, service.website_id, serviceId, nicheId, finalContent.headline, finalContent.subheadline,
        JSON.stringify(finalContent.pain_points), JSON.stringify(finalContent.approach),
        JSON.stringify(finalContent.proof_points), JSON.stringify(finalContent.faq), finalContent.cta.slice(0, 255), ctaUrl,
        // No keyword research anymore (see proof gate above) — grounding provenance is
        // the matched case-study ids, stored so a reviewer can see WHY this pair generated.
        // The legacy research keys stay present (empty) because the deployed frontend
        // route reads onPageCandidates from this column — a missing key risks a crash
        // where an empty array is already handled gracefully.
        JSON.stringify({ proof: matchedCaseStudies.map((c) => c.id), marketSignal: [], onPageCandidates: [], serpFindings: [] }),
        finalContent.meta_title.slice(0, 255), finalContent.meta_description.slice(0, 500),
        lastReview?.score ?? null, qualityGateExhausted ? false : true, JSON.stringify(lastReview?.issues ?? [])
      ]
    );

    if (embedding) {
      await this.solutionEmbeddings.upsert({ id, serviceId, embedding });
    }
    return !qualityGateExhausted;
  }

  /** Batch-generate for every service x niche combo on a website that has no solutions row yet. */
  async generatePendingSolutions(websiteId: string, limit: number): Promise<number> {
    if (limit <= 0) return 0;
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT s.id AS service_id, n.id AS niche_id
         FROM services s
         CROSS JOIN niches n
        WHERE s.website_id = ? AND n.website_id = ? AND n.status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM solutions sol WHERE sol.service_id = s.id AND sol.niche_id = n.id
          )
        LIMIT ?`,
      [websiteId, websiteId, limit]
    );

    let done = 0;
    for (const r of rows as any[]) {
      try {
        const ok = await this.generateSolutionContent(String(r.service_id), String(r.niche_id));
        if (ok) done++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          `[SolutionsService] ⚠️ generation failed for service ${r.service_id} x niche ${r.niche_id}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return done;
  }

  /**
   * The shared generate-check-review retry loop used by BOTH page tiers (niche
   * pages and service-level pages). Two gates, sequenced so they're mutually
   * exclusive per attempt (never both charged on the same attempt): the free
   * deterministic screen runs first; a hard block rejects immediately; "too thin"
   * retries on the free check alone, skipping the paid LLM review for that
   * attempt; only a CLEAN attempt gets reviewed by the LLM. A live test
   * (2026-08-01) showed the model doesn't reliably hit the word-count floor from
   * prompt instruction alone, hence the retry rather than a single shot.
   */
  private async runPageQualityLoop(args: {
    buildPrompt: (retryFeedback?: string) => { system: string; user: string };
    voicePerspective: VoicePerspective;
    serviceName: string;
    /** What the reviewer treats as the audience — the niche name, or a cross-industry label for service pages. */
    reviewNicheLabel: string;
    logLabel: string;
  }): Promise<{
    finalContent: SolutionsPageContent | null;
    lastReview: SolutionsReviewResult | null;
    qualityGateExhausted: boolean;
    hardRejected: boolean;
  }> {
    const MAX_ATTEMPTS = 3;
    let content: SolutionsPageContent | null = null;
    let lastContent: SolutionsPageContent | null = null;
    let lastReview: SolutionsReviewResult | null = null;
    let retryFeedback: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const isFinal = attempt === MAX_ATTEMPTS;
      const prompt = args.buildPrompt(retryFeedback);

      const raw = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: prompt.user,
        temperature: 0.5,
        // 8192, matching humanizer.ts — 4096 was observed truncating mid-JSON on
        // final-attempt responses (2026-08-01) once retry feedback pushed the page
        // toward the SOLUTIONS_MIN_WORDS floor with case-study detail woven in.
        maxOutputTokens: 8192
      });

      let parsed: SolutionsPageContent;
      try {
        parsed = solutionsContentSchema.parse(safeJsonParse(raw));
      } catch (err) {
        // A truncated/malformed response (e.g. hit maxOutputTokens mid-string while
        // trying to address retry feedback) must not crash the whole generation —
        // treat it as a retryable attempt, falling back to whatever the last
        // successfully-parsed attempt produced if this was the final one.
        // Schema violations get their own targeted feedback: a generic "keep it
        // concise so the JSON fits" message on a too-many-items error was observed
        // (2026-08-01) making the model shrink EVERY field and land under the
        // word-count floor — the opposite of what the depth requirement needs.
        const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 150);
        if (!isFinal) {
          retryFeedback = err instanceof z.ZodError
            ? `Your last response had the wrong shape: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300)}. Fix the structure (e.g. at most 6 items per list) while keeping each item fully detailed — do not shorten the writing itself.`
            : `Your last response was not valid, complete JSON (${errMsg}) — it may have been cut off. Return ONLY complete, valid JSON.`;
          // eslint-disable-next-line no-console
          console.log(`[SolutionsService] ↻ attempt ${attempt} returned invalid JSON — retrying: ${errMsg}`);
          continue;
        }
        // eslint-disable-next-line no-console
        console.log(`[SolutionsService] ⚠️ attempt ${attempt} (final) returned invalid JSON, falling back to the last valid attempt if any: ${errMsg}`);
        break;
      }
      const fix = (t: string) =>
        fixAiVocabulary(args.voicePerspective === 'first_person_singular' ? fixSingularPronouns(t) : t);
      const attemptContent: SolutionsPageContent = {
        ...parsed,
        headline: fix(parsed.headline),
        subheadline: fix(parsed.subheadline),
        cta: fix(parsed.cta),
        meta_title: fix(parsed.meta_title),
        meta_description: fix(parsed.meta_description),
        pain_points: parsed.pain_points.map(fix),
        proof_points: parsed.proof_points.map(fix),
        approach: parsed.approach.map((a) => ({ step: fix(a.step), description: fix(a.description) })),
        faq: parsed.faq.map((f) => ({ question: fix(f.question), answer: fix(f.answer) }))
      };
      lastContent = attemptContent;

      const violation = this.findContentViolation(attemptContent, args.voicePerspective);
      const thinMatch = violation?.match(/^page is too thin \((\d+) words/);

      if (violation && !thinMatch) {
        // Hard block (fabrication, NDA name, off-brand vocab/fear pattern, pricing scope,
        // AI-tell word, pronoun mismatch) — never retried, never stored.
        // eslint-disable-next-line no-console
        console.log(`[SolutionsService] ⚠️ rejected ${args.logLabel}: ${violation}`);
        return { finalContent: null, lastReview, qualityGateExhausted: false, hardRejected: true };
      }

      if (violation && thinMatch && !isFinal) {
        const shortfall = env.SOLUTIONS_MIN_WORDS - Number(thinMatch[1]);
        retryFeedback = `Your last attempt was only ${thinMatch[1]} words, ${shortfall} short of the ${env.SOLUTIONS_MIN_WORDS}-word minimum. Expand every pain point to 2-3 full sentences, every approach step's description to 2-3 sentences, and every faq answer to 3-5 sentences — do not just add filler, add real specifics.`;
        // eslint-disable-next-line no-console
        console.log(`[SolutionsService] ↻ attempt ${attempt} too thin (${thinMatch[1]} words) — retrying with explicit feedback, no review call this attempt`);
        continue;
      }

      // Either clean, or thin-but-final (run the LLM review anyway as a best-effort
      // diagnostic for the human review queue, not for retry purposes).
      const review = await reviewSolutionContent({
        gemini: this.deps.gemini,
        content: attemptContent,
        serviceName: args.serviceName,
        nicheName: args.reviewNicheLabel
      });
      lastReview = review;

      if (!violation && review.passed) {
        content = attemptContent;
        break;
      }
      if (isFinal) break;

      retryFeedback = `Your last attempt scored ${review.score}/100 (need ${SOLUTIONS_PASS_THRESHOLD}). Fix: ` +
        review.issues.map((i) => `${i.code}: ${i.message}`).join('; ');
      // eslint-disable-next-line no-console
      console.log(`[SolutionsService] ↻ attempt ${attempt} review score ${review.score}/100 (need ${SOLUTIONS_PASS_THRESHOLD}) — retrying with explicit feedback`);
    }

    return {
      finalContent: content ?? lastContent,
      lastReview,
      qualityGateExhausted: !content,
      hardRejected: false
    };
  }

  /**
   * Generate (or regenerate) the SERVICE-LEVEL page for one service — the primary
   * standalone sales page at /solutions/{serviceSlug}, cross-industry, drawing
   * proof from every niche with matched case studies. Costs Gemini calls only.
   * No dedup/embedding pass: five hand-curated services, each reviewed by a
   * human before publish, can't meaningfully near-duplicate each other.
   */
  async generateServicePage(serviceId: string, opts?: { force?: boolean }): Promise<boolean> {
    if (!env.SOLUTIONS_GENERATION_ENABLED) {
      // eslint-disable-next-line no-console
      console.log(
        '[SolutionsService] ⏸ solutions generation is disabled (the curated matrix is fully written and published, 2026-08-01). ' +
        'Set SOLUTIONS_GENERATION_ENABLED=true to re-enable when new case studies or niches justify new pages.'
      );
      return false;
    }
    const [[serviceRow]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, website_id, name, slug, short_pitch, page_status, reviewed_by FROM services WHERE id = ?`,
      [serviceId]
    );
    if (!serviceRow) return false;
    const service = serviceRow as any;

    const website = await this.websiteService.getById(String(service.website_id));
    if (!website) return false;

    if ((service.page_status === 'published' || service.reviewed_by) && !opts?.force) {
      // eslint-disable-next-line no-console
      console.log(
        `[SolutionsService] ⚠️ refusing to regenerate service page "${service.name}": already ${service.page_status}` +
        `${service.reviewed_by ? ` and reviewed by ${service.reviewed_by}` : ''} — pass { force: true } to override and re-queue for review`
      );
      return false;
    }

    // Gather every approved niche that has real proof, so the page can lead with
    // industry stories and let the cross-industry spread itself build credibility.
    const niches = await this.listNiches(String(service.website_id));
    const nichesWithProof = niches
      .map((n) => ({ nicheName: n.name, caseStudies: getCaseStudiesForNiche(n.slug) }))
      .filter((n) => n.caseStudies.length > 0);

    const loop = await this.runPageQualityLoop({
      buildPrompt: (retryFeedback) => servicePageContentPrompt({
        serviceName: String(service.name),
        servicePitch: service.short_pitch ?? null,
        websiteDomain: website.domain,
        brandName: website.brandName,
        nichesWithProof,
        defaultCtaText: website.defaultCtaText,
        defaultCtaUrl: website.defaultCtaUrl,
        voicePerspective: website.voicePerspective,
        retryFeedback
      }),
      voicePerspective: website.voicePerspective,
      serviceName: String(service.name),
      reviewNicheLabel: 'growing service businesses (cross-industry service page)',
      logLabel: `service page "${service.name}"`
    });
    if (loop.hardRejected || !loop.finalContent) return false;
    const { finalContent, lastReview, qualityGateExhausted } = loop;

    if (qualityGateExhausted) {
      // eslint-disable-next-line no-console
      console.log(
        `[SolutionsService] ⚠️ service page "${service.name}" exhausted all attempts without clearing the ` +
        `quality gate (last score: ${lastReview?.score ?? 'n/a'}/100) — storing as draft for human review rather than discarding`
      );
    }

    const ctaUrl = buildSolutionCtaUrl(website.defaultCtaUrl, String(service.slug), 'service');
    await this.deps.pool.query<ResultSetHeader>(
      `UPDATE services
          SET content_json = ?, cta_url = ?, page_status = 'draft',
              reviewed_by = NULL, reviewed_at = NULL,
              ai_review_score = ?, ai_review_passed = ?, ai_review_issues_json = ?, ai_reviewed_at = NOW(),
              content_generated_at = NOW()
        WHERE id = ?`,
      [
        JSON.stringify(finalContent), ctaUrl,
        lastReview?.score ?? null, qualityGateExhausted ? false : true,
        JSON.stringify(lastReview?.issues ?? []), serviceId
      ]
    );
    return !qualityGateExhausted;
  }

  /** Human sign-off for a service-level page. Same override philosophy as approveSolution. */
  async approveServicePage(serviceId: string, reviewedBy: string): Promise<boolean> {
    const [result] = await this.deps.pool.query<ResultSetHeader>(
      `UPDATE services SET reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND content_json IS NOT NULL`,
      [reviewedBy, serviceId]
    );
    return result.affectedRows > 0;
  }

  /** Requires reviewed_by IS NOT NULL — same publish gate as niche pages. */
  async publishServicePage(serviceId: string): Promise<boolean> {
    const [[row]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT reviewed_by, ai_review_passed, content_json FROM services WHERE id = ?`,
      [serviceId]
    );
    if (!row || !(row as any).content_json || !(row as any).reviewed_by) {
      // eslint-disable-next-line no-console
      console.log(`[SolutionsService] ⚠️ refusing to publish service page ${serviceId}: no content or not yet approved (call approveServicePage first)`);
      return false;
    }
    if ((row as any).ai_review_passed === 0) {
      // eslint-disable-next-line no-console
      console.log(`[SolutionsService] ⚠️ publishing service page ${serviceId} despite a failed AI review (human override) — audit trail: reviewed_by is set`);
    }
    await this.deps.pool.query<ResultSetHeader>(`UPDATE services SET page_status = 'published' WHERE id = ?`, [serviceId]);
    return true;
  }

  /** Service pages awaiting review (draft with content), worst-first like listForReview. */
  async listServicePagesForReview(websiteId: string): Promise<Array<{ id: string; name: string; slug: string; aiReviewScore: number | null; aiReviewPassed: boolean | null; reviewedBy: string | null; wordCount: number }>> {
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT id, name, slug, content_json, ai_review_score, ai_review_passed, reviewed_by
         FROM services
        WHERE website_id = ? AND page_status = 'draft' AND content_json IS NOT NULL
        ORDER BY ai_review_passed ASC, ai_review_score ASC`,
      [websiteId]
    );
    return (rows as any[]).map((r) => {
      const c = (typeof r.content_json === 'string' ? JSON.parse(r.content_json) : r.content_json) as SolutionsPageContent;
      return {
        id: String(r.id),
        name: String(r.name),
        slug: String(r.slug),
        aiReviewScore: r.ai_review_score ?? null,
        aiReviewPassed: r.ai_review_passed === null ? null : Boolean(r.ai_review_passed),
        reviewedBy: r.reviewed_by ?? null,
        wordCount: [
          c.headline, c.subheadline, c.cta,
          ...c.pain_points, ...c.proof_points,
          ...c.approach.flatMap((a) => [a.step, a.description]),
          ...c.faq.flatMap((f) => [f.question, f.answer])
        ].join(' ').split(/\s+/).filter(Boolean).length
      };
    });
  }

  /**
   * Human sign-off. Does NOT require ai_review_passed=true — a human should be able to
   * override an AI verdict they disagree with, after actually seeing the content. Also
   * unconditionally recomputes and upserts the embedding: this is the one point where a
   * previously exhausted-quality-gate row (never embedded, per generateSolutionContent's
   * dedup-placement rule) enters the dedup corpus, now that a human has vouched for it.
   */
  async approveSolution(id: string, reviewedBy: string): Promise<boolean> {
    const [[row]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT service_id, headline, subheadline, pain_points_json FROM solutions WHERE id = ?`,
      [id]
    );
    if (!row) return false;
    const r = row as any;

    await this.deps.pool.query<ResultSetHeader>(
      `UPDATE solutions SET reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
      [reviewedBy, id]
    );

    const painPoints: string[] = Array.isArray(r.pain_points_json) ? r.pain_points_json : [];
    const embeddingText = `${r.headline}\n${r.subheadline}\n${painPoints.join(' ')}`;
    const embedding = await this.deps.gemini.embedText(embeddingText);
    await this.solutionEmbeddings.upsert({ id, serviceId: String(r.service_id), embedding });
    return true;
  }

  /** Requires reviewed_by IS NOT NULL — the one real gate for publish. */
  async publishSolution(id: string): Promise<boolean> {
    const [[row]] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT reviewed_by, ai_review_passed FROM solutions WHERE id = ?`,
      [id]
    );
    if (!row || !(row as any).reviewed_by) {
      // eslint-disable-next-line no-console
      console.log(`[SolutionsService] ⚠️ refusing to publish ${id}: not yet approved (call approveSolution first)`);
      return false;
    }
    if ((row as any).ai_review_passed === 0) {
      // eslint-disable-next-line no-console
      console.log(`[SolutionsService] ⚠️ publishing ${id} despite a failed AI review (human override) — audit trail: reviewed_by is set`);
    }
    await this.deps.pool.query<ResultSetHeader>(`UPDATE solutions SET status = 'published' WHERE id = ?`, [id]);
    return true;
  }

  /** Batch-publish every approved (reviewed_by set), still-draft solution for a website. */
  async publishApprovedSolutions(websiteId: string): Promise<number> {
    const [result] = await this.deps.pool.query<ResultSetHeader>(
      `UPDATE solutions SET status = 'published' WHERE website_id = ? AND status = 'draft' AND reviewed_by IS NOT NULL`,
      [websiteId]
    );
    return result.affectedRows;
  }

  /** The review queue: draft solutions for a website, worst-first so a human triages failures first. */
  async listForReview(websiteId: string): Promise<SolutionReviewRow[]> {
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT sol.id, sol.headline, sol.ai_review_score, sol.ai_review_passed, sol.reviewed_by,
              sol.pain_points_json, sol.approach_json, sol.proof_points_json, sol.faq_json,
              sol.cta_text, s.name AS service_name, s.slug AS service_slug, n.name AS niche_name, n.slug AS niche_slug
         FROM solutions sol
         JOIN services s ON s.id = sol.service_id
         JOIN niches n ON n.id = sol.niche_id
        WHERE sol.website_id = ? AND sol.status = 'draft'
        ORDER BY sol.ai_review_passed ASC, sol.ai_review_score ASC`,
      [websiteId]
    );
    return (rows as any[]).map((r) => ({
      id: String(r.id),
      headline: String(r.headline),
      aiReviewScore: r.ai_review_score ?? null,
      aiReviewPassed: r.ai_review_passed === null ? null : Boolean(r.ai_review_passed),
      reviewedBy: r.reviewed_by ?? null,
      serviceName: String(r.service_name),
      serviceSlug: String(r.service_slug),
      nicheName: String(r.niche_name),
      nicheSlug: String(r.niche_slug),
      wordCount: [
        r.headline, r.cta_text,
        ...(r.pain_points_json ?? []), ...(r.proof_points_json ?? []),
        ...((r.approach_json ?? []) as Array<{ step: string; description: string }>).flatMap((a) => [a.step, a.description]),
        ...((r.faq_json ?? []) as Array<{ question: string; answer: string }>).flatMap((f) => [f.question, f.answer])
      ].join(' ').split(/\s+/).filter(Boolean).length
    }));
  }

  /**
   * Deterministic content screen (mirrors brandRedaction.ts / postReviewer.ts's
   * automated checks): numeric claims must come from the real evidence inventory,
   * NDA-covered client names must never appear, pricing must never appear in a
   * field that can render as a raw SERP snippet, the page must not read as thin
   * (a word-count floor, since blog posts get one via POST_MIN_WORDS and the
   * first two generated solutions pages came in at 463 and 686 words), pronouns
   * must match the site's actual voice (a solo-founder site must never say
   * "we"/"our"/"us"), and AI-tell vocabulary must not appear (this was previously
   * prompt-only for solutions pages; blog backs the same instruction with this
   * exact deterministic list via postReviewer.ts). Returns a human-readable
   * reason, or null if clean.
   */
  private findContentViolation(
    content: z.infer<typeof solutionsContentSchema>,
    voicePerspective: VoicePerspective
  ): string | null {
    const allowed = getAllowedNumericClaims();
    const allTextParts = [
      content.headline, content.subheadline, content.cta,
      ...content.pain_points, ...content.proof_points,
      ...content.approach.flatMap((a) => [a.step, a.description]),
      ...content.faq.flatMap((f) => [f.question, f.answer])
    ];
    const allText = allTextParts.join(' \n ');

    for (const m of allText.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
      if (!allowed.has(m[1]!)) return `unapproved numeric claim "${m[0]}"`;
    }
    for (const m of allText.matchAll(/(\d+(?:\.\d+)?)x\b/gi)) {
      if (!allowed.has(`${m[1]}x`)) return `unapproved numeric claim "${m[0]}"`;
    }

    const lower = allText.toLowerCase();
    for (const name of CLIENT_NAME_BLOCKLIST) {
      if (lower.includes(name)) return `NDA-covered client name "${name}" appeared in output`;
    }

    // Hard blocks, not blog's soft -10 penalty — these are commercial pages selling the
    // same brand, and both lists already exist in brandKnowledge.ts (used by blog's
    // postReviewer.ts/brandRedaction.ts) but were never wired into solutions pages until now.
    for (const word of BRAND_VOCABULARY_BLOCKLIST) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(allText)) return `off-brand vocabulary "${word}" appeared in output`;
    }
    for (const { pattern, label } of BRAND_FEAR_PATTERNS) {
      if (pattern.test(allText)) return `fear-mongering pattern (${label}) appeared in output`;
    }

    for (const field of NO_PRICE_FIELDS) {
      const value = content[field];
      if (DOLLAR_FIGURE_RE.test(value)) {
        return `dollar figure appeared in "${field}" ("${value}") — pricing is only allowed in an FAQ answer`;
      }
    }

    const wordCount = allText.split(/\s+/).filter(Boolean).length;
    if (wordCount < env.SOLUTIONS_MIN_WORDS) {
      return `page is too thin (${wordCount} words, minimum is ${env.SOLUTIONS_MIN_WORDS})`;
    }

    // Pronoun rules govern the BRAND's voice only — client quotes are the client
    // speaking, so quoted spans are exempt (mirrors fixSingularPronouns; without
    // this the fixer and checker would force a client's own "we" to be rewritten).
    const brandVoiceText = textOutsideQuotes(allText);
    if (voicePerspective === 'first_person_singular') {
      const pluralMatch = brandVoiceText.match(/\b(we|we're|we'll|we've|our|ours|us)\b/i);
      if (pluralMatch) {
        return `plural pronoun "${pluralMatch[0]}" appeared on a solo-founder (first-person-singular) page`;
      }
    } else if (voicePerspective === 'first_person_plural') {
      const singularMatch = brandVoiceText.match(/\bI\b|\bI'm\b|\bI'll\b|\bI've\b|\bmy\b|\bmine\b/i);
      if (singularMatch) {
        return `singular pronoun "${singularMatch[0]}" appeared on a first-person-plural page`;
      }
    }

    for (const word of AI_VOCABULARY_BLOCKLIST) {
      const re = new RegExp(`\\b${word}\\b`, 'i');
      if (re.test(allText)) return `AI-tell word "${word}" appeared in output`;
    }

    return null;
  }
}
