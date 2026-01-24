import crypto from 'node:crypto';
import type { Pool as MysqlPool, ResultSetHeader } from 'mysql2/promise';
import type { GeminiClient } from '../llm/geminiClient.js';
import { env } from '../config/env.js';
import { keywordEnrichmentPrompt } from '../prompts/keywordEnrichment.js';
import { serpKeywordExtractionPrompt } from '../prompts/serpKeywordExtraction.js';
import { sleep } from '../utils/sleep.js';
import { z } from 'zod';
import { MysqlSerpUsageStore } from './serpUsageStore.js';

export interface KeywordServiceDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
}

interface DiscoveredKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string | null;
}

const enrichmentSchema = z.object({
  items: z.array(
    z.object({
      keyword: z.string().min(1),
      volume: z.number().int().nonnegative(),
      difficulty: z.number().min(0).max(100),
      cpc: z.number().nonnegative(),
      intent: z.string().min(1)
    })
  )
});

export interface KeywordDiscoveryResult {
  discovered: number;
  filtered: number;
  inserted: number;
}

export class KeywordService {
  private scraperxLastRequestAtMs = 0;
  private readonly serpUsage: MysqlSerpUsageStore;

  constructor(private readonly deps: KeywordServiceDeps) {
    this.serpUsage = new MysqlSerpUsageStore(deps.pool);
  }

  async discoverAndStoreKeywords(): Promise<KeywordDiscoveryResult> {
    const discovered = await this.discoverKeywords();
    const filtered = discovered.filter((k) => this.passesFilters(k));

    let inserted = 0;
    for (const k of filtered) {
      const id = crypto.randomUUID();
      const [res] = await this.deps.pool.query<ResultSetHeader>(
        `
        INSERT IGNORE INTO keywords(id, keyword, volume, difficulty, cpc, intent, status)
        VALUES (?, ?, ?, ?, ?, ?, 'new')
        `,
        [id, k.keyword, k.volume, k.difficulty, k.cpc, k.intent]
      );
      inserted += res.affectedRows ?? 0;
    }

    return { discovered: discovered.length, filtered: filtered.length, inserted };
  }

  private passesFilters(k: DiscoveredKeyword): boolean {
    const volumeOk = (k.volume ?? 0) > 50; // Lowered from 100
    const difficultyOk = k.difficulty == null || k.difficulty < 50; // Raised from 40
    const cpcOk = (k.cpc ?? 0) > 1.0; // Lowered from 2.0

    const intent = (k.intent ?? '').toLowerCase();
    const intentOk = 
      intent.includes('commercial') || 
      intent.includes('founder') || 
      intent.includes('cto') ||
      intent.includes('transactional') ||
      intent.includes('service') ||
      intent.includes('hire') ||
      intent.includes('consulting');

    return volumeOk && difficultyOk && cpcOk && intentOk;
  }

  private async discoverKeywords(): Promise<DiscoveredKeyword[]> {
    const seeds = [
      // ===== PAIN POINT KEYWORDS (Problem-aware, high intent) =====
      'technical debt solutions',
      'failed software project recovery',
      'why do software projects fail',
      'software project rescue services',
      'legacy system modernization',
      'fix slow software application',
      'software security audit services',
      'technical due diligence checklist',
      
      // ===== COST/PRICING KEYWORDS (Decision stage, very high intent) =====
      'software development cost estimate',
      'how much does custom software cost',
      'mvp development cost breakdown',
      'cto consulting rates per hour',
      'app development pricing guide',
      'software consultant hourly rate',
      'cost to build a saas product',
      'offshore development rates 2024',
      
      // ===== COMPARISON KEYWORDS (Evaluating options) =====
      'toptal alternatives for startups',
      'upwork vs development agency',
      'in-house vs outsourced development',
      'fractional cto vs full-time cto',
      'offshore vs nearshore development',
      'agency vs freelance developers',
      'staff augmentation vs dedicated team',
      
      // ===== URGENCY/TIMELINE KEYWORDS (Hot leads) =====
      'fast mvp development',
      'rapid prototyping services',
      'quick software development',
      'emergency software developer',
      'launch product in 3 months',
      'accelerate software development',
      
      // ===== INDUSTRY VERTICAL KEYWORDS (Niche, high conversion) =====
      'fintech software development',
      'healthcare app development hipaa',
      'real estate software solutions',
      'logistics software development',
      'ecommerce platform development',
      'edtech software development',
      'legaltech software solutions',
      
      // ===== OUTCOME-BASED KEYWORDS (Results-focused) =====
      'scale startup engineering team',
      'reduce software development costs',
      'improve app performance',
      'automate business processes',
      'build investor-ready mvp',
      'prepare startup for acquisition tech',
      
      // ===== ROLE-BASED KEYWORDS (Target decision makers) =====
      'cto services for non-technical founders',
      'technical advisor for startups',
      'interim cto for hire',
      'virtual cto services',
      'startup technical leadership',
      'technology strategy consultant',
      
      // ===== AI/ML SPECIFIC (Hot market) =====
      'integrate chatgpt into business',
      'custom ai solution development',
      'ai automation for small business',
      'machine learning consulting services',
      'build ai powered application',
      'llm fine tuning services',
      'ai implementation roadmap',
      
      // ===== LONG-TAIL TRANSACTIONAL (Ready to buy) =====
      'hire senior software developers',
      'find technical co-founder',
      'software development rfp template',
      'development team for equity startup',
      'white label software development',
      'software development partnership',
      
      // ===== TRUST/CREDIBILITY KEYWORDS =====
      'vetted software developers',
      'top rated software consultants',
      'proven mvp development company',
      'experienced startup developers',
      'enterprise grade development team',

      // ===== TECH STACK SPECIFIC (Developers searching) =====
      'node.js development company',
      'react native app development',
      'python development services',
      'typescript consulting',
      'aws architecture consulting',
      'kubernetes consulting services',
      'microservices architecture consultant',
      'graphql api development',
      'postgresql database consulting',
      'redis implementation services',
      'docker consulting services',
      'terraform infrastructure consulting',

      // ===== BUSINESS MODEL KEYWORDS =====
      'saas product development',
      'marketplace platform development',
      'subscription app development',
      'b2b software development',
      'enterprise software consulting',
      'mobile app development for startups',
      'web application development services',
      'api first development',
      'headless commerce development',
      'multi-tenant saas architecture',

      // ===== FUNDING STAGE KEYWORDS (Target by company stage) =====
      'pre-seed startup tech partner',
      'series a technical due diligence',
      'post-funding software development',
      'bootstrapped startup development',
      'venture backed startup cto',
      'investor ready product development',
      'startup runway optimization tech',

      // ===== QUESTION KEYWORDS (Top of funnel, builds authority) =====
      'how to find a technical cofounder',
      'how to hire developers for startup',
      'how to build an mvp',
      'how to choose a development partner',
      'what to look for in a cto',
      'when to hire a fractional cto',
      'how to manage offshore developers',
      'how to reduce development costs',
      'how to validate startup idea technically',
      'how to prepare for technical interview as founder',

      // ===== PROBLEM/MISTAKE KEYWORDS =====
      'software development red flags',
      'signs of bad software architecture',
      'common mvp development mistakes',
      'why startups fail technically',
      'software project management issues',
      'development team communication problems',
      'technical debt warning signs',
      'offshore development horror stories',
      'failed app development recovery',

      // ===== BEST/TOP/REVIEW KEYWORDS =====
      'best mvp development companies',
      'top software consulting firms',
      'best fractional cto services',
      'best ai development companies',
      'top startup development agencies',
      'best practices software development',
      'best tech stack for startups 2024',
      'best countries for outsourcing development',

      // ===== COMPETITOR ALTERNATIVE KEYWORDS =====
      'turing.com alternatives',
      'andela alternatives',
      'toptal competitors',
      'clutch.co top developers',
      'fiverr pro alternatives for startups',
      'gigster alternatives',
      'software development companies like thoughtbot',

      // ===== LOCATION-BASED KEYWORDS =====
      'software development usa',
      'european software developers',
      'nearshore development latin america',
      'eastern europe developers',
      'software development australia',
      'uk software consulting',
      'remote software development team',
      'timezone friendly developers',

      // ===== USE CASE SPECIFIC =====
      'crm custom development',
      'inventory management software custom',
      'booking system development',
      'payment integration development',
      'dashboard development services',
      'data analytics platform development',
      'workflow automation development',
      'customer portal development',
      'admin panel development',
      'reporting system development',

      // ===== CONTRACT/ENGAGEMENT KEYWORDS =====
      'time and materials development',
      'fixed price software development',
      'retainer software development',
      'project based development team',
      'dedicated development team model',
      'software development sla',
      'development team augmentation',
      'managed development services',

      // ===== SECURITY/COMPLIANCE KEYWORDS (High-value clients) =====
      'soc 2 compliant development',
      'gdpr compliant software development',
      'pci dss development services',
      'hipaa compliant app development',
      'secure software development practices',
      'penetration testing services',
      'security code review services',
      'compliance software consulting',

      // ===== SCALING KEYWORDS =====
      'scale application performance',
      'handle high traffic application',
      'database optimization consulting',
      'application scalability audit',
      'cloud migration services',
      'serverless architecture consulting',
      'performance optimization services',
      'load testing services',

      // ===== PROCESS/METHODOLOGY KEYWORDS =====
      'agile development consulting',
      'devops implementation services',
      'ci cd pipeline setup',
      'code review services',
      'technical documentation services',
      'software architecture review',
      'development process audit',
      'engineering team assessment',

      // ===== EXIT/ACQUISITION KEYWORDS (High-value) =====
      'technical due diligence for acquisition',
      'prepare codebase for acquisition',
      'software asset valuation',
      'tech stack assessment for investors',
      'clean up technical debt for exit',
      'startup acquisition technical review'
    ];

    // Preferred: SERP providers (Serpstack / Zenserp) for keyword expansion.
    // Note: SERP APIs generally don't provide volume/CPC; we enrich those via Gemini.
    const candidates: Array<{ keyword: string; commercialSerpSignal: boolean }> = [];

    for (const seed of seeds) {
      const fromSerpstack = await this.serpstackRelatedQueries(seed);
      candidates.push(...fromSerpstack);

      const fromZenserp = await this.zenserpRelatedQueries(seed);
      candidates.push(...fromZenserp);

      if (fromSerpstack.length === 0 && fromZenserp.length === 0) {
        const fromScraperX = await this.scraperxKeywordIdeasFromSerp(seed);
        if (fromScraperX.length > 0) {
          candidates.push(...fromScraperX.map((s) => ({ keyword: s, commercialSerpSignal: false })));
          continue;
        }

        // Last fallback: Google Suggest
        const suggestions = await this.googleSuggest(seed);
        candidates.push(...suggestions.map((s) => ({ keyword: s, commercialSerpSignal: false })));
      }
    }

    const unique = dedupeStrings(candidates.map((c) => c.keyword)).slice(0, 40);
    if (unique.length === 0) return [];

    const enriched = await this.enrichWithGemini(unique);

    // If SERP indicates ads, bias intent toward commercial.
    const commercialSignalSet = new Set(
      candidates.filter((c) => c.commercialSerpSignal).map((c) => c.keyword.toLowerCase())
    );
    for (const k of enriched) {
      if (commercialSignalSet.has(k.keyword.toLowerCase())) {
        const current = (k.intent ?? '').toLowerCase();
        if (!current.includes('commercial')) k.intent = 'commercial';
      }
    }

    return dedupe(enriched).slice(0, 50);
  }

  private async enrichWithGemini(keywords: string[]): Promise<DiscoveredKeyword[]> {
    const prompt = keywordEnrichmentPrompt({ keywords });
    let raw = await this.deps.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.2,
      maxOutputTokens: 4096
    });

    let validated: { items: Array<{ keyword: string; volume: number; difficulty: number; cpc: number; intent: string }> };
    try {
      const parsed = safeJsonParse(raw);
      validated = enrichmentSchema.parse(parsed);
    } catch {
      raw = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: `${prompt.user}\n\nIMPORTANT:\n- Return ONLY a single JSON object.\n- Do NOT wrap in Markdown fences.\n- No trailing commas, no comments, no extra keys.\n`,
        temperature: 0,
        maxOutputTokens: 4096
      });
      try {
        const parsed = safeJsonParse(raw);
        validated = enrichmentSchema.parse(parsed);
      } catch {
        const snippet = raw.replace(/\s+/g, ' ').slice(0, 800);
        throw new Error(`KeywordService: Gemini did not return valid JSON. Raw (first 800 chars): ${snippet}`);
      }
    }
    return validated.items.map((i) => ({
      keyword: i.keyword,
      volume: i.volume,
      difficulty: i.difficulty,
      cpc: i.cpc,
      intent: i.intent
    }));
  }

  private async scraperxKeywordIdeasFromSerp(seed: string): Promise<string[]> {
    const apiKey = env.SCRAPPER_X_API?.trim();
    if (!apiKey) return [];

    // ScraperX is typically limited to ~1 request/second.
    const now = Date.now();
    const waitMs = this.scraperxLastRequestAtMs + 1100 - now;
    if (waitMs > 0) await sleep(waitMs);
    this.scraperxLastRequestAtMs = Date.now();

    type Resp = {
      organic?: Array<{ title?: string; url?: string; snippet?: string; description?: string }>;
    };

    try {
      const res = await fetch('https://api.scraperx.com/api/v1/google/search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({
          keyword: seed,
          country: 'us',
          language: 'en',
          limit: 10,
          page: 1
        }),
        signal: AbortSignal.timeout(30_000)
      });

      if (!res.ok) return [];
      const json = (await res.json()) as Resp;

      const organic = Array.isArray(json.organic) ? json.organic : [];
      if (organic.length === 0) return [];

      const prompt = serpKeywordExtractionPrompt({
        seed,
        organicResults: organic.slice(0, 6).map((r) => ({
          title: r.title,
          snippet: r.snippet ?? r.description,
          url: r.url
        }))
      });

      const raw = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: prompt.user,
        temperature: 0.2,
        maxOutputTokens: 1024
      });

      const schema = z.object({ items: z.array(z.string().min(1)).max(30) });
      const parsed = safeJsonParse(raw);
      const validated = schema.parse(parsed);
      return dedupeStrings(validated.items).slice(0, 20);
    } catch {
      return [];
    }
  }

  private serpstackKeys(): string[] {
    return [...new Set(splitCommaList(env.SERPSTACK_APIS))];
  }

  private zenserpKeys(): string[] {
    return [...new Set(splitCommaList(env.ZENSERP_APIS))];
  }

  private async pickSerpstackKey(): Promise<{ apiKey: string; apiKeyHash: string } | null> {
    const picked = await this.serpUsage.pickLeastUsedKey({
      provider: 'serpstack',
      apiKeys: this.serpstackKeys(),
      perKeyMonthlyLimit: env.SERPSTACK_MAX_LIMIT
    });
    return picked ? { apiKey: picked.apiKey, apiKeyHash: picked.apiKeyHash } : null;
  }

  private async pickZenserpKey(): Promise<{ apiKey: string; apiKeyHash: string } | null> {
    const picked = await this.serpUsage.pickLeastUsedKey({
      provider: 'zenserp',
      apiKeys: this.zenserpKeys(),
      perKeyMonthlyLimit: env.ZENSERP_MAX_LIMIT
    });
    return picked ? { apiKey: picked.apiKey, apiKeyHash: picked.apiKeyHash } : null;
  }

  private async serpstackRelatedQueries(seed: string): Promise<Array<{ keyword: string; commercialSerpSignal: boolean }>> {
    const picked = await this.pickSerpstackKey();
    if (!picked) return [];
    const apiKey = picked.apiKey;

    const url = new URL('https://api.serpstack.com/search');
    url.searchParams.set('access_key', apiKey);
    url.searchParams.set('query', seed);
    url.searchParams.set('engine', 'google');
    url.searchParams.set('num', '10');
    url.searchParams.set('gl', 'us');
    url.searchParams.set('hl', 'en');
    url.searchParams.set('device', 'desktop');

    type Resp = {
      request?: { success?: boolean };
      success?: boolean;
      error?: unknown;
      related_searches?: Array<{ text?: string }>;
      related_questions?: Array<{ question?: string }>;
      ads?: unknown[];
    };

    let json: Resp | null = null;
    try {
      const res = await fetch(url);
      if (res.ok) json = (await res.json()) as Resp;
    } finally {
      await this.serpUsage.increment('serpstack', picked.apiKeyHash);
    }

    if (!json) return [];

    if ((json as any).success === false) return [];

    const commercialSerpSignal = Array.isArray(json.ads) && json.ads.length > 0;

    const out: Array<{ keyword: string; commercialSerpSignal: boolean }> = [];
    for (const r of json.related_searches ?? []) {
      const q = r.text?.trim();
      if (q) out.push({ keyword: q, commercialSerpSignal });
    }
    for (const r of json.related_questions ?? []) {
      const q = r.question?.trim();
      if (q) out.push({ keyword: q, commercialSerpSignal });
    }

    return out;
  }

  private async zenserpRelatedQueries(seed: string): Promise<Array<{ keyword: string; commercialSerpSignal: boolean }>> {
    const picked = await this.pickZenserpKey();
    if (!picked) return [];
    const apiKey = picked.apiKey;

    const url = new URL('https://app.zenserp.com/api/v2/search');
    url.searchParams.set('q', seed);
    url.searchParams.set('num', '10');
    url.searchParams.set('gl', 'us');
    url.searchParams.set('hl', 'en');

    type Resp = {
      paid_results?: unknown[];
      organic?: Array<{
        title?: string;
        questions?: Array<{ question?: string }>;
      }>;
      related_searches?: Array<{ query?: string } | string>;
    };

    let json: Resp | null = null;
    try {
      const res = await fetch(url, { headers: { apikey: apiKey } });
      if (res.ok) json = (await res.json()) as Resp;
    } finally {
      await this.serpUsage.increment('zenserp', picked.apiKeyHash);
    }

    if (!json) return [];

    const commercialSerpSignal = Array.isArray(json.paid_results) && json.paid_results.length > 0;
    const out: Array<{ keyword: string; commercialSerpSignal: boolean }> = [];

    for (const item of json.organic ?? []) {
      for (const q of item.questions ?? []) {
        const text = q.question?.trim();
        if (text) out.push({ keyword: text, commercialSerpSignal });
      }
    }

    for (const r of json.related_searches ?? []) {
      if (typeof r === 'string') {
        const text = r.trim();
        if (text) out.push({ keyword: text, commercialSerpSignal });
      } else {
        const text = r.query?.trim();
        if (text) out.push({ keyword: text, commercialSerpSignal });
      }
    }

    return out;
  }

  private async dataForSeoKeywordsForKeywords(seeds: string[]): Promise<DiscoveredKeyword[]> {
    const url = 'https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live';
    const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString('base64');

    const body = seeds.map((seed) => ({
      keywords: [seed],
      language_name: 'English',
      location_name: 'United States'
    }));

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DataForSEO HTTP ${res.status}: ${text}`);
    }

    type Resp = {
      tasks?: Array<{
        result?: Array<{
          items?: Array<{
            keyword?: string;
            search_volume?: number;
            competition?: number;
            cpc?: number;
          }>;
        }>;
      }>;
    };

    const json = (await res.json()) as Resp;
    const items: DiscoveredKeyword[] = [];

    for (const task of json.tasks ?? []) {
      for (const result of task.result ?? []) {
        for (const it of result.items ?? []) {
          const keyword = it.keyword?.trim();
          if (!keyword) continue;
          const competition = typeof it.competition === 'number' ? it.competition : null;
          const difficulty = competition == null ? null : Math.round(Math.max(0, Math.min(1, competition)) * 100);
          items.push({
            keyword,
            volume: typeof it.search_volume === 'number' ? it.search_volume : null,
            difficulty,
            cpc: typeof it.cpc === 'number' ? it.cpc : null,
            intent: null
          });
        }
      }
    }

    return items;
  }

  private async googleSuggest(seed: string): Promise<string[]> {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(seed)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as [string, string[]];
    return Array.isArray(data?.[1]) ? data[1] : [];
  }
}

function dedupe(items: DiscoveredKeyword[]): DiscoveredKeyword[] {
  const map = new Map<string, DiscoveredKeyword>();
  for (const k of items) map.set(k.keyword.toLowerCase(), k);
  return [...map.values()];
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

function splitCommaList(value?: string): string[] {
  if (!value) return [];
  // Accept values with or without quotes; .env often uses quotes.
  const trimmed = value.trim().replace(/^"|"$/g, '');
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeJsonParse(raw: string): unknown {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());

  for (const candidate of candidates) {
    const cleaned = candidate.replace(/^\uFEFF/, '');
    const objStart = cleaned.indexOf('{');
    const objEnd = cleaned.lastIndexOf('}');
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');

    let slice = cleaned;
    const hasObj = objStart >= 0 && objEnd > objStart;
    const hasArr = arrStart >= 0 && arrEnd > arrStart;
    if (hasObj || hasArr) {
      if (hasArr && (!hasObj || arrEnd - arrStart > objEnd - objStart)) {
        slice = cleaned.slice(arrStart, arrEnd + 1);
      } else if (hasObj) {
        slice = cleaned.slice(objStart, objEnd + 1);
      }
    }

    const withoutTrailingCommas = slice.replace(/,(\s*[}\]])/g, '$1');

    try {
      return JSON.parse(withoutTrailingCommas);
    } catch {
      // try next candidate
    }
  }

  // Truncation recovery: try to salvage partial items array from truncated response.
  const recovered = recoverTruncatedItemsArray(trimmed);
  if (recovered) return recovered;

  throw new Error('KeywordService: Gemini did not return valid JSON');
}

/**
 * Attempt to recover a partial {"items": [...]} structure from a truncated response.
 * Extracts all complete {...} objects inside the items array.
 */
function recoverTruncatedItemsArray(raw: string): { items: unknown[] } | null {
  const itemsMatch = raw.match(/"items"\s*:\s*\[/);
  if (!itemsMatch) return null;

  const arrStart = (itemsMatch.index ?? 0) + itemsMatch[0].length;
  const substring = raw.slice(arrStart);

  const items: unknown[] = [];
  let depth = 0;
  let objStart = -1;

  for (let i = 0; i < substring.length; i++) {
    const ch = substring[i];
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const objStr = substring.slice(objStart, i + 1);
        try {
          items.push(JSON.parse(objStr));
        } catch {
          // skip malformed object
        }
        objStart = -1;
      }
    }
  }

  return items.length > 0 ? { items } : null;
}
