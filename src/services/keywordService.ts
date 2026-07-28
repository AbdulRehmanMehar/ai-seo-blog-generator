import crypto from 'node:crypto';
import type { Pool as MysqlPool, ResultSetHeader } from 'mysql2/promise';
import type { GeminiClient } from '../llm/geminiClient.js';
import { env } from '../config/env.js';
import { keywordEnrichmentPrompt } from '../prompts/keywordEnrichment.js';
import { serpKeywordExtractionPrompt } from '../prompts/serpKeywordExtraction.js';
import { sleep } from '../utils/sleep.js';
import { z } from 'zod';
import { MysqlSerpUsageStore, hashApiKey } from './serpUsageStore.js';
import { loadIcps } from '../knowledge/icpKnowledge.js';
import { mapConcurrent } from '../utils/concurrency.js';

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
  /** How many came from GSC near-miss (proven demand). */
  gscImported: number;
  /** 'gsc' = pool filled from GSC alone; 'serp' = needed SERP expansion to supplement. */
  source: 'gsc' | 'serp';
}

export class KeywordService {
  private scraperxLastRequestAtMs = 0;
  private readonly serpUsage: MysqlSerpUsageStore;

  constructor(private readonly deps: KeywordServiceDeps) {
    this.serpUsage = new MysqlSerpUsageStore(deps.pool);
  }

  /**
   * Recycle old 'used' keywords that haven't been used for a post in 30+ days.
   * This allows re-targeting popular keywords with fresh content.
   */
  async recycleOldKeywords(): Promise<number> {
    // Reset keywords that were used but never resulted in a LIVE post.
    // CANNIBALIZATION GUARD: a keyword with ANY published post must NEVER return
    // to the new-post pool — a second post on the same keyword competes with the
    // first and Google ranks neither well (this exact mechanism produced 230
    // competing posts across 105 keywords). Freshness for those keywords comes
    // from REFRESHING the existing post (GSC-driven refresh detectors), never
    // from writing a competitor.
    const [result] = await this.deps.pool.query<ResultSetHeader>(`
      UPDATE keywords k
      SET k.status = 'new'
      WHERE k.status = 'used'
        AND k.created_at < DATE_SUB(NOW(), INTERVAL 14 DAY)
        AND NOT EXISTS (
          SELECT 1 FROM posts p
          WHERE LOWER(TRIM(p.primary_keyword)) = LOWER(TRIM(k.keyword))
            AND p.status IN ('published', 'draft', 'pending_review')
        )
      LIMIT 10
    `);
    
    const recycled = result.affectedRows ?? 0;
    if (recycled > 0) {
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] ♻️ Recycled ${recycled} old keywords back to 'new' status`);
    }
    return recycled;
  }

  async discoverAndStoreKeywords(): Promise<KeywordDiscoveryResult> {
    // Recycle stale keywords back into the pool.
    await this.recycleOldKeywords();

    // ── GSC-FIRST ────────────────────────────────────────────────────────────
    // Primary source: GSC near-miss queries (pages your site already ranks 5–20 for).
    // This is PROVEN demand + proven relevance, so it leads — before any SERP scraping.
    const gscImported = await this.importNearMissKeywords();

    // If the unused-keyword pool is already healthy (GSC imports + leftovers from prior
    // runs), skip SERP expansion entirely — real demand beats scraped related-searches.
    const unused = await this.countUnusedKeywords();
    if (unused >= env.KEYWORD_POOL_TARGET) {
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] 🎯 GSC-first: ${unused} unused keyword(s) available (≥${env.KEYWORD_POOL_TARGET}); skipping SERP expansion (+${gscImported} new from GSC near-miss).`);
      return { discovered: gscImported, filtered: gscImported, inserted: gscImported, gscImported, source: 'gsc' };
    }

    // ── SERP EXPANSION (supplement only) ─────────────────────────────────────
    // Pool is thin → expand via SERP providers to DISCOVER new long-tail topics.
    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 🔎 Only ${unused} unused keyword(s) (target ${env.KEYWORD_POOL_TARGET}); expanding via SERP providers to supplement…`);
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

    // Last resort: if SERP + GSC both produced nothing and the pool is empty, AI-generate.
    if (inserted === 0 && gscImported === 0 && unused === 0) {
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] ⚠️ No new keywords from GSC or SERP, generating AI-only keywords...`);
      const aiInserted = await this.generateAndInsertAiOnlyKeywords();
      inserted += aiInserted;
    }

    return { discovered: discovered.length, filtered: filtered.length, inserted: inserted + gscImported, gscImported, source: 'serp' };
  }

  /** Count keywords still available for topic planning (status='new'). */
  private async countUnusedKeywords(): Promise<number> {
    const [rows] = await this.deps.pool.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM keywords WHERE status = 'new'`
    );
    return Number((rows[0] as any)?.c ?? 0);
  }

  /**
   * Generate keywords purely from AI when SERP providers are exhausted.
   * Uses Gemini to generate fresh, commercially-relevant keywords.
   */
  private async generateAndInsertAiOnlyKeywords(): Promise<number> {
    try {
      // Force clear the cache to get fresh AI ideas
      await this.deps.pool.query(
        `DELETE FROM keyword_seed_cache WHERE cache_key = 'ai_seed_cache'`
      );
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] 🗑️ Cleared AI seed cache to force fresh generation`);

      // Get current used keywords to avoid duplicates
      const [usedRows] = await this.deps.pool.query<import('mysql2/promise').RowDataPacket[]>(
        `SELECT keyword FROM keywords WHERE status IN ('used', 'new') LIMIT 100`
      );
      const usedKeywords = (usedRows as any[]).map(r => r.keyword.toLowerCase());

      // Load ICP business problems for problem-first framing
      let icpProblems: string[] = [];
      try {
        const icps = await loadIcps();
        icpProblems = icps.flatMap(icp => [
          icp.the_crap_he_deals_with,
          icp.the_hunger,
          `Cost of inaction: ${icp.cost_of_inaction}`,
        ]);
      } catch { /* non-fatal */ }

      // Generate fresh AI keywords
      const prompt = this.buildDirectKeywordPrompt(usedKeywords, icpProblems);
      
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] 🤖 Generating AI-only keywords (1 API call)...`);
      const raw = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: prompt.user,
        temperature: 0.8, // Higher creativity for diversity
      });

      const schema = z.object({
        keywords: z.array(z.object({
          keyword: z.string().min(3).max(100),
          volume: z.number().int().nonnegative(),
          cpc: z.number().nonnegative(),
          intent: z.string().min(1)
        })).min(1).max(20)
      });

      const parsed = safeJsonParse(raw);
      const validated = schema.parse(parsed);
      const candidates = validated.keywords.filter((k) => !usedKeywords.includes(k.keyword.toLowerCase()));

      // REAL-DEMAND VALIDATION GATE — this is a last-resort fallback (GSC and SERP
      // expansion both came up empty), so the LLM's volume/cpc/difficulty here are
      // pure guesses, not measurements. Treat them as SEED IDEAS ONLY: every one must
      // clear a live DataForSEO check before it's allowed into the keywords table,
      // same gate the primary discoverKeywords() path already enforces. Without this,
      // a fabricated-looking-real number (e.g. "volume: 320") is indistinguishable
      // from genuine DataForSEO data once it's in the table — exactly the contamination
      // that caused ~64% of the historic corpus to target zero-volume phantom demand.
      if (!this.dataForSeoEnabled()) {
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] ⚠️ DataForSEO not configured — refusing to insert ${candidates.length} unverified AI-guessed keyword(s) (fail closed, not open).`);
        return 0;
      }
      const realMetrics = await this.dataForSeoSearchVolume(candidates.map((k) => k.keyword));
      const realCandidates = candidates
        .map((k) => ({ ...k, real: realMetrics.get(k.keyword.toLowerCase()) }))
        .filter((k) => k.real && (k.real.volume ?? 0) > 0);
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] ✅ Real-demand gate on AI-only fallback: ${realCandidates.length}/${candidates.length} kept (rest had zero/unknown real search volume — LLM guess only, discarded)`);

      let inserted = 0;
      for (const k of realCandidates) {
        const id = crypto.randomUUID();
        const [res] = await this.deps.pool.query<ResultSetHeader>(
          `INSERT IGNORE INTO keywords(id, keyword, volume, difficulty, cpc, intent, status)
           VALUES (?, ?, ?, ?, ?, ?, 'new')`,
          [id, k.keyword, k.real!.volume, k.real!.difficulty ?? 30, k.real!.cpc ?? k.cpc, k.intent]
        );
        inserted += res.affectedRows ?? 0;
      }

      // eslint-disable-next-line no-console
      console.log(`[KeywordService] ✅ AI-only fallback inserted ${inserted} DataForSEO-verified keywords`);
      return inserted;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] ⚠️ AI-only keyword generation failed:`, err);
      return 0;
    }
  }

  private buildDirectKeywordPrompt(usedKeywords: string[], icpProblems: string[] = []): { system: string; user: string } {
    const usedList = usedKeywords.slice(0, 30).join(', ');

    const icpSection = icpProblems.length > 0
      ? `\nREAL ICP BUSINESS PROBLEMS — generate keywords targeting these exact pains:\n${icpProblems.slice(0, 15).map(p => `- ${p}`).join('\n')}\n`
      : '';

    return {
      system: `You are an SEO expert specializing in B2B software development and CTO consulting keywords.

CORE PRINCIPLE: Be a PROBLEM SEEKER, not a service vendor.
- "Size of problem = size of budget" — find keywords that signal LARGE, COSTLY business problems
- Target business problems that happen to be solved by software, not just software products
- Every keyword should represent a real business pain, not a service category

Generate high-converting, commercially-focused keywords that target:
- Non-technical founders looking to hire developers/CTOs
- Startups needing software development services
- Companies seeking technical consulting
- Decision-makers evaluating tech partnerships

Return ONLY valid JSON, no markdown.`,
      user: `Generate 15-20 NEW commercial keywords for a software consulting/CTO services business.

ALREADY USED (DO NOT REPEAT): ${usedList}
${icpSection}
Requirements:
1. High commercial intent (people ready to buy/hire)
2. Mix of:
   - Business problem-first ("legacy software holding back growth", "engineering team can't scale")
   - Cost/pricing ("cto consulting rates", "software development cost")
   - Comparison ("agency vs freelancer", "toptal alternatives")
   - Cost of inaction ("cost of delaying software modernization")
   - Acquisition/exit prep ("technical debt before acquisition")
3. Estimated volume > 50, CPC > $1.50
4. Include intent classification

Return JSON:
{
  "keywords": [
    {"keyword": "example keyword phrase", "volume": 200, "cpc": 5.50, "intent": "commercial"},
    ...
  ]
}`
    };
  }

  private passesFilters(k: DiscoveredKeyword): boolean {
    // IMPORTANT: volume / difficulty / cpc are NOT real metrics here. SERP providers
    // (Serpstack/Zenserp) return only related searches & questions — never volume/CPC/
    // difficulty. Those fields are *estimated by Gemini*, i.e. effectively hallucinated.
    // We therefore must NOT reject a keyword based on them: doing so both discards
    // genuinely good keywords (because fiction said "low volume") and lends false
    // confidence to the ones that survive.
    //
    // The only defensible signal at discovery time is INTENT, derived from the keyword
    // text itself (and SERP ad presence). So intent is the sole gate here. Real demand is
    // enforced downstream: GSC near-miss keywords (proven impressions) get a +60 boost in
    // TopicPlanner, and the LLM only selects `selectCount` topics from the ranked pool —
    // so a larger, looser candidate set is safe.
    const intent = (k.intent ?? '').toLowerCase();
    const intentOk =
      intent.includes('commercial') ||
      intent.includes('founder') ||
      intent.includes('cto') ||
      intent.includes('transactional') ||
      intent.includes('service') ||
      intent.includes('hire') ||
      intent.includes('consulting');

    return intentOk;
  }

  /**
   * Calculate intent score for prioritizing high-intent keywords
   * Higher score = higher priority for content generation
   * 
   * Search Intent Priority (from feedback):
   * 1. Transactional (HIGHEST) - "cost to build", "hire developer"
   * 2. Commercial Investigation - "firebase vs supabase"
   * 3. Problem-aware - "why my app is slow"
   * 4. Informational (LOWEST) - "what is AI"
   */
  private calculateIntentScore(k: DiscoveredKeyword): number {
    const keyword = k.keyword.toLowerCase();
    const intent = (k.intent ?? '').toLowerCase();
    let score = 0;

    // TRANSACTIONAL indicators (highest priority)
    if (keyword.includes('cost') || keyword.includes('price') || keyword.includes('rates')) score += 40;
    if (keyword.includes('hire') || keyword.includes('find')) score += 40;
    if (keyword.includes('buy') || keyword.includes('purchase')) score += 40;
    if (keyword.includes('best') && (keyword.includes('company') || keyword.includes('developer') || keyword.includes('agency'))) score += 35;
    
    // COMMERCIAL INVESTIGATION indicators
    if (keyword.includes(' vs ') || keyword.includes(' vs. ') || keyword.includes('versus')) score += 30;
    if (keyword.includes('alternatives') || keyword.includes('competitors')) score += 30;
    if (keyword.includes('comparison') || keyword.includes('compare')) score += 25;
    
    // PROBLEM-AWARE indicators
    if (keyword.includes('mistakes') || keyword.includes('failing') || keyword.includes('wrong')) score += 25;
    if (keyword.includes('why') && (keyword.includes('fail') || keyword.includes('slow') || keyword.includes('break'))) score += 20;
    if (keyword.includes('problems') || keyword.includes('issues')) score += 20;
    if (keyword.includes('debt') || keyword.includes('legacy') || keyword.includes('modernization')) score += 20;
    
    // Intent field boosters
    if (intent.includes('transactional')) score += 25;
    if (intent.includes('commercial')) score += 20;
    if (intent.includes('hire')) score += 15;
    if (intent.includes('service')) score += 10;
    
    // CPC boost (higher CPC = more commercial intent)
    if ((k.cpc ?? 0) > 5) score += 15;
    else if ((k.cpc ?? 0) > 3) score += 10;
    else if ((k.cpc ?? 0) > 2) score += 5;

    // Volume boost (moderate - we want volume but not at expense of intent)
    if ((k.volume ?? 0) > 500) score += 10;
    else if ((k.volume ?? 0) > 200) score += 5;

    return score;
  }

  private async discoverKeywords(): Promise<DiscoveredKeyword[]> {
    const seeds = [
      // Brand-aligned seeds (July 2026): digital friction for growing businesses,
      // $20k-$50k buyers (owners, non-technical founders, ops leads). Enterprise
      // seeds (due diligence, KYC/AML, defense, pharma) deliberately removed.

      // ===== BOOKING, INTAKE & CUSTOMER EXPERIENCE =====
      'online booking system for small business',
      'custom booking system development',
      'why customers abandon online booking',
      'appointment scheduling software for clinics',
      'hotel direct booking website',
      'client intake process automation',
      'customer portal for small business',
      'online ordering system for restaurants',
      'improve website conversion rate small business',

      // ===== DISCONNECTED TOOLS & INTEGRATIONS =====
      'connect crm to scheduling software',
      'integrate business software tools',
      'stop double data entry between systems',
      'sync data between business apps',
      'custom api integration for small business',
      'replace spreadsheets with custom software',
      'automate data transfer between systems',

      // ===== WORKFLOW AUTOMATION & PRACTICAL AI =====
      'workflow automation for small business',
      'automate repetitive office tasks',
      'ai assistant for small business',
      'automate client follow up',
      'automate weekly business reports',
      'business process automation for growing business',
      'ai chatbot for customer service small business',
      'automate invoice processing',
      'ai automation for recruiting agency',
      'automate employee onboarding paperwork',
      'reduce manual admin work',
      'digitize paper processes',

      // ===== WEBSITE & PERFORMANCE =====
      'slow website losing customers',
      'website redesign for growing business',
      'fix slow web application',
      'website performance optimization service',
      'modernize outdated business website',

      // ===== MVP & NON-TECHNICAL FOUNDERS =====
      'mvp development for non technical founder',
      'how to build an mvp without a cto',
      'rebuild app after bad development experience',
      'developer disappeared mid project',
      'rescue stalled software project',
      'app development for startup founder',
      'custom software for growing business',
      'how much does custom software cost',
      'phased software development approach',

      // ===== CHOOSING A PARTNER / TRUST =====
      'how to choose a software development partner',
      'freelance developer vs agency',
      'questions to ask before hiring a developer',
      'software development red flags',
      'fixed price vs hourly software development',
      'trusted developer for long term project',

      // ===== VERTICALS (service businesses we can win) =====
      'software for property management company',
      'custom crm for real estate agents',
      'recruiting agency automation software',
      'job board development',
      'software for medical clinic operations',
      'inventory management for small retailer',
      'custom dashboard for business owners',
      'field service scheduling software',
      'ecommerce site speed optimization',

      // ===== OPERATIONS LEADERSHIP =====
      'operations dashboard for growing business',
      'systems for scaling operations team',
      'business reporting automation'
    ];

    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 📋 Static seeds: ${seeds.length}`);

    // ===== AI-POWERED SEED EXPANSION =====
    // Only generate AI seeds once per day to conserve API quota
    const aiGeneratedSeeds = await this.generateAiSeedsWithCache(seeds);
    const allSeeds = [...seeds, ...aiGeneratedSeeds];
    
    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 🤖 AI seeds: ${aiGeneratedSeeds.length} | Total: ${allSeeds.length}`);

    // Preferred: SERP providers (Serpstack / Zenserp) for keyword expansion.
    // Note: SERP APIs generally don't provide volume/CPC; we enrich those via Gemini.
    const candidates: Array<{ keyword: string; commercialSerpSignal: boolean }> = [];

    // Shuffle and limit seeds to avoid hitting rate limits on every seed
    const shuffledSeeds = shuffleArray(allSeeds).slice(0, 30);
    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 🎲 Selected ${shuffledSeeds.length} random seeds for this run`);

    let serpstackHits = 0, zenserpHits = 0, scraperxHits = 0, googleSuggestHits = 0;

    for (const seed of shuffledSeeds) {
      const fromSerpstack = await this.serpstackRelatedQueries(seed);
      if (fromSerpstack.length > 0) serpstackHits++;
      candidates.push(...fromSerpstack);

      const fromZenserp = await this.zenserpRelatedQueries(seed);
      if (fromZenserp.length > 0) zenserpHits++;
      candidates.push(...fromZenserp);

      if (fromSerpstack.length === 0 && fromZenserp.length === 0) {
        const fromScraperX = await this.scraperxKeywordIdeasFromSerp(seed);
        if (fromScraperX.length > 0) {
          scraperxHits++;
          candidates.push(...fromScraperX.map((s) => ({ keyword: s, commercialSerpSignal: false })));
          continue;
        }

        // Last fallback: Google Suggest
        const suggestions = await this.googleSuggest(seed);
        if (suggestions.length > 0) googleSuggestHits++;
        candidates.push(...suggestions.map((s) => ({ keyword: s, commercialSerpSignal: false })));
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 📊 SERP Provider Results:`);
    // eslint-disable-next-line no-console
    console.log(`   Serpstack: ${serpstackHits} seeds returned results (quota may be exhausted if 0)`);
    // eslint-disable-next-line no-console
    console.log(`   Zenserp: ${zenserpHits} seeds returned results (quota may be exhausted if 0)`);
    // eslint-disable-next-line no-console
    console.log(`   ScraperX: ${scraperxHits} seeds returned results`);
    // eslint-disable-next-line no-console
    console.log(`   Google Suggest: ${googleSuggestHits} seeds returned results`);
    // eslint-disable-next-line no-console
    console.log(`   Total raw candidates: ${candidates.length}`);

    // DataForSEO keyword IDEAS — the strongest expansion source since every idea
    // arrives with REAL Google Ads metrics. Ideas join the candidate pool and
    // their metrics pre-fill the validation map (no double-paying for them).
    const knownMetrics = new Map<string, { volume: number | null; cpc: number | null; difficulty: number | null }>();
    if (this.dataForSeoEnabled()) {
      try {
        const ideas = await this.dataForSeoKeywordsForKeywords(shuffledSeeds.slice(0, 20));
        for (const idea of ideas) {
          candidates.push({ keyword: idea.keyword, commercialSerpSignal: false });
          knownMetrics.set(idea.keyword.toLowerCase(), { volume: idea.volume, cpc: idea.cpc, difficulty: idea.difficulty });
        }
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] 💡 DataForSEO ideas: ${ideas.length} (with real metrics)`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] ⚠️ DataForSEO ideas failed (continuing without): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const unique = dedupeStrings(candidates.map((c) => c.keyword)).slice(0, this.dataForSeoEnabled() ? 80 : 40);
    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 🔄 After dedup: ${unique.length} unique keywords`);

    if (unique.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] ⚠️ No keywords found from any provider!`);
      return [];
    }

    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 🤖 Enriching ${unique.length} keywords with Gemini...`);
    const enriched = await this.enrichWithGemini(unique);
    // eslint-disable-next-line no-console
    console.log(`[KeywordService] ✅ Enrichment complete: ${enriched.length} keywords`);

    // ── REAL-DEMAND VALIDATION GATE (DataForSEO) ─────────────────────────────
    // Replace the LLM's estimated metrics with real Google Ads data and REJECT
    // anything with zero/unknown volume — no more posts targeting phantom demand.
    // (GSC near-miss keywords never pass through here; they are proven demand.)
    if (this.dataForSeoEnabled()) {
      try {
        const missing = enriched
          .map((k) => k.keyword.toLowerCase())
          .filter((k) => !knownMetrics.has(k));
        const fetched = await this.dataForSeoSearchVolume(missing);
        for (const [k, m] of fetched) knownMetrics.set(k, m);

        const before = enriched.length;
        const validated = enriched.filter((k) => {
          const m = knownMetrics.get(k.keyword.toLowerCase());
          if (!m || !m.volume || m.volume <= 0) return false;
          k.volume = m.volume;
          if (m.cpc != null) k.cpc = m.cpc;
          if (m.difficulty != null) k.difficulty = m.difficulty;
          return true;
        });
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] ✅ Real-demand gate: ${validated.length} kept, ${before - validated.length} rejected (zero/unknown search volume)`);
        enriched.length = 0;
        enriched.push(...validated);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] ⚠️ DataForSEO validation failed (keeping LLM estimates): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

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

    // Sort by intent score to prioritize high-intent keywords (transactional > commercial > problem-aware)
    const scored = enriched
      .map(k => ({ ...k, intentScore: this.calculateIntentScore(k) }))
      .sort((a, b) => b.intentScore - a.intentScore);
    
    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 📊 Intent scores: avg=${Math.round(scored.reduce((s, k) => s + k.intentScore, 0) / scored.length)}, max=${scored[0]?.intentScore ?? 0}, top keyword: "${scored[0]?.keyword}"`);

    // Remove score field before returning
    return dedupe(scored.map(({ intentScore, ...k }) => k)).slice(0, 50);
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
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) json = (await res.json()) as Resp;
    } catch {
      // timeout or network error — treat as no results
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
      const res = await fetch(url, { headers: { apikey: apiKey }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) json = (await res.json()) as Resp;
    } catch {
      // timeout or network error — treat as no results
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

  dataForSeoEnabled(): boolean {
    return Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);
  }

  /**
   * Shared DataForSEO POST: auth, timeout, error surface, spend metering.
   * Every response reports its cost; we log it and count the request in
   * serp_usage_monthly alongside the free SERP providers.
   */
  private async dataForSeoPost(path: string, tasks: unknown[]): Promise<any> {
    const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString('base64');
    const res = await fetch(`https://api.dataforseo.com/v3${path}`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(tasks),
      signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok) {
      throw new Error(`DataForSEO HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json: any = await res.json();
    try {
      await this.serpUsage.increment('dataforseo', hashApiKey(env.DATAFORSEO_LOGIN ?? 'dataforseo'));
    } catch { /* metering is best-effort */ }
    if (typeof json?.cost === 'number' && json.cost > 0) {
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] 💰 DataForSEO cost: $${json.cost.toFixed(4)}`);
    }
    return json;
  }

  private static parseAdsKeywordItems(json: any): DiscoveredKeyword[] {
    const items: DiscoveredKeyword[] = [];
    for (const task of json?.tasks ?? []) {
      if (task?.status_code && task.status_code !== 20000) {
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] ⚠️ DataForSEO task failed: ${task.status_code} ${task.status_message ?? ''}`);
        continue;
      }
      for (const result of task?.result ?? []) {
        // google_ads endpoints return keyword objects either directly in result[]
        // (search_volume) or nested under result[].items (keywords_for_keywords).
        const entries = Array.isArray(result?.items) ? result.items : [result];
        for (const it of entries) {
          const keyword = typeof it?.keyword === 'string' ? it.keyword.trim() : '';
          if (!keyword) continue;
          const competition = typeof it.competition === 'number' ? it.competition
            : typeof it.competition_index === 'number' ? it.competition_index / 100 : null;
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

  /**
   * Keyword IDEAS with real metrics for a set of seeds. Google Ads allows up to
   * 20 seed keywords per task, so seeds are chunked — one task fee per chunk,
   * not per seed.
   */
  private async dataForSeoKeywordsForKeywords(seeds: string[]): Promise<DiscoveredKeyword[]> {
    if (!this.dataForSeoEnabled() || seeds.length === 0) return [];
    const clean = dedupeStrings(seeds.map((s) => s.trim()).filter(Boolean));
    const chunks: string[][] = [];
    for (let i = 0; i < clean.length; i += 20) chunks.push(clean.slice(i, i + 20));
    // Live endpoints accept ONE task per request (max 20 seed keywords each);
    // chunks are independent, so fetch several concurrently instead of one at a time.
    const results = await mapConcurrent(chunks, 5, async (chunk) => {
      const json = await this.dataForSeoPost('/keywords_data/google_ads/keywords_for_keywords/live', [
        { keywords: chunk, language_name: 'English', location_name: 'United States' }
      ]);
      return KeywordService.parseAdsKeywordItems(json);
    });
    return results.flat();
  }

  /**
   * Real Google Ads metrics for EXACT keywords (the validation workhorse).
   * Public so audit/diagnostic scripts can reuse it. Up to 1000 keywords per
   * task; chunked at 700 for headroom. Returns a lowercase-keyed map.
   */
  async dataForSeoSearchVolume(
    keywords: string[]
  ): Promise<Map<string, { volume: number | null; cpc: number | null; difficulty: number | null }>> {
    const out = new Map<string, { volume: number | null; cpc: number | null; difficulty: number | null }>();
    if (!this.dataForSeoEnabled()) return out;

    // Google Ads rejects keywords with special symbols or >10 words, and ONE bad
    // keyword fails its whole task. Sanitize, remember sanitized→originals, and
    // chunk small enough that a failing chunk loses little.
    const sanitize = (k: string) =>
      k.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    const originalsBySanitized = new Map<string, string[]>();
    for (const original of keywords) {
      const key = original.trim().toLowerCase();
      const s = sanitize(key);
      if (s.length < 3 || s.length > 80 || s.split(' ').length > 10) continue;
      const arr = originalsBySanitized.get(s) ?? [];
      if (!arr.includes(key)) arr.push(key);
      originalsBySanitized.set(s, arr);
    }
    const clean = [...originalsBySanitized.keys()];
    if (clean.length === 0) return out;

    // Live endpoints accept ONE task per request; chunks are independent, so
    // fetch several concurrently instead of one at a time.
    const volChunks: string[][] = [];
    for (let i = 0; i < clean.length; i += 200) volChunks.push(clean.slice(i, i + 200));
    await mapConcurrent(volChunks, 5, async (chunk, ci) => {
      try {
        const json = await this.dataForSeoPost('/keywords_data/google_ads/search_volume/live', [
          { keywords: chunk, language_name: 'English', location_name: 'United States' }
        ]);
        for (const item of KeywordService.parseAdsKeywordItems(json)) {
          const metrics = { volume: item.volume, cpc: item.cpc, difficulty: item.difficulty };
          const resultKey = item.keyword.toLowerCase();
          out.set(resultKey, metrics);
          // Map back to every original spelling that sanitized to this keyword.
          for (const original of originalsBySanitized.get(sanitize(resultKey)) ?? []) {
            out.set(original, metrics);
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] ⚠️ search_volume chunk ${ci + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return out;
  }

  /**
   * Live Google SERP top-10 for a keyword (DataForSEO). This is the winnability
   * evidence: Ads "difficulty" measures advertiser competition, not organic —
   * only the actual page 1 tells us whether our domain can crack it.
   */
  async dataForSeoSerpTop(keyword: string): Promise<Array<{ position: number; domain: string; title: string }>> {
    if (!this.dataForSeoEnabled()) return [];
    const json = await this.dataForSeoPost('/serp/google/organic/live/regular', [
      { keyword, language_name: 'English', location_name: 'United States', depth: 10 }
    ]);
    const out: Array<{ position: number; domain: string; title: string }> = [];
    for (const task of json?.tasks ?? []) {
      if (task?.status_code && task.status_code !== 20000) {
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] ⚠️ SERP task failed for "${keyword}": ${task.status_code} ${task.status_message ?? ''}`);
        continue;
      }
      for (const result of task?.result ?? []) {
        for (const it of result?.items ?? []) {
          if (it?.type && it.type !== 'organic') continue;
          const domain = typeof it?.domain === 'string' ? it.domain : '';
          if (!domain) continue;
          out.push({
            position: typeof it.rank_absolute === 'number' ? it.rank_absolute : out.length + 1,
            domain,
            title: typeof it.title === 'string' ? it.title : ''
          });
        }
      }
    }
    return out.slice(0, 10);
  }

  private async googleSuggest(seed: string): Promise<string[]> {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(seed)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];
      const data = (await res.json()) as [string, string[]];
      return Array.isArray(data?.[1]) ? data[1] : [];
    } catch {
      return [];
    }
  }

  /**
   * AI-powered seed keyword generation with caching.
   * Only generates new seeds once per day to conserve API quota.
   * Uses 1 Gemini API call per day (not per pipeline run).
   */
  private async generateAiSeedsWithCache(existingSeeds: string[]): Promise<string[]> {
    const cacheKey = 'ai_seed_cache';
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    try {
      // Check if we already generated seeds today (using UTC for consistency)
      const [cacheRows] = await this.deps.pool.query<import('mysql2/promise').RowDataPacket[]>(
        `SELECT seeds, generated_at FROM keyword_seed_cache WHERE cache_key = ? LIMIT 1`,
        [cacheKey]
      );

      const cached = cacheRows[0] as { seeds: string; generated_at: Date } | undefined;
      
      if (cached) {
        // Compare dates in UTC
        const cachedDate = cached.generated_at.toISOString().slice(0, 10);
        if (cachedDate === today) {
          const seeds = JSON.parse(cached.seeds) as string[];
          // eslint-disable-next-line no-console
          console.log(`[KeywordService] 💾 Using cached AI seeds from today (${seeds.length} seeds)`);
          return seeds;
        }
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] 📅 Cache expired (from ${cachedDate}, today is ${today}), generating new AI seeds...`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] 🆕 No cache found, generating AI seeds for first time...`);
      }

      // Generate new seeds
      const newSeeds = await this.generateAiSeeds(existingSeeds);

      // Save to cache
      if (newSeeds.length > 0) {
        await this.deps.pool.query(
          `INSERT INTO keyword_seed_cache (cache_key, seeds, generated_at) 
           VALUES (?, ?, NOW())
           ON DUPLICATE KEY UPDATE seeds = VALUES(seeds), generated_at = NOW()`,
          [cacheKey, JSON.stringify(newSeeds)]
        );
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] 💾 Cached ${newSeeds.length} AI seeds for today`);
      }

      return newSeeds;
    } catch (err) {
      // If cache table doesn't exist or other error, just generate without caching
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] ⚠️ Cache unavailable, generating AI seeds directly:`, err);
      return this.generateAiSeeds(existingSeeds);
    }
  }

  /**
   * AI-powered seed keyword generation.
   * Uses multiple strategies to generate fresh keyword ideas:
   * 1. Analyze successful keywords from DB
   * 2. Generate variations based on patterns
   * 3. Explore trending topics in the niche
   * 4. Cross-pollinate ideas from different categories
   */
  private async generateAiSeeds(existingSeeds: string[]): Promise<string[]> {
    // eslint-disable-next-line no-console
    console.log(`[KeywordService] 🤖 Starting AI seed generation...`);
    
    try {
      // Get insights from existing keywords in DB
      // eslint-disable-next-line no-console
      console.log(`[KeywordService]    → Fetching successful keywords from DB...`);
      const [usedKeywords] = await this.deps.pool.query<import('mysql2/promise').RowDataPacket[]>(
        `SELECT keyword, volume, cpc, intent FROM keywords 
         WHERE status IN ('used', 'new') 
         ORDER BY COALESCE(cpc, 0) DESC, COALESCE(volume, 0) DESC 
         LIMIT 20`
      );

      const successfulKeywords = (usedKeywords as any[]).map(k => k.keyword);
      // eslint-disable-next-line no-console
      console.log(`[KeywordService]    → Found ${successfulKeywords.length} keywords in DB`);
      
      // Get posts that have been successfully created with their titles
      const [successfulPosts] = await this.deps.pool.query<import('mysql2/promise').RowDataPacket[]>(
        `SELECT p.title, p.primary_keyword 
         FROM posts p 
         WHERE p.status IN ('published', 'draft')
         ORDER BY p.created_at DESC
         LIMIT 10`
      );

      const postTitles = (successfulPosts as any[]).map(p => p.title);
      // eslint-disable-next-line no-console
      console.log(`[KeywordService]    → Found ${postTitles.length} successful post titles`);

      // Load ICP business problems to ground seeds in real buyer pain
      let icpProblems: string[] = [];
      try {
        const icps = await loadIcps();
        icpProblems = icps.flatMap(icp => [
          icp.the_crap_he_deals_with,
          icp.the_hunger,
          `Cost of inaction: ${icp.cost_of_inaction}`,
        ]);
      } catch { /* non-fatal */ }

      const prompt = this.buildAiSeedPrompt(existingSeeds, successfulKeywords, postTitles, icpProblems);
      
      // eslint-disable-next-line no-console
      console.log(`[KeywordService]    → Calling Gemini for seed generation (1 API call)...`);
      const raw = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: prompt.user + '\n\nCRITICAL: Return ONLY raw JSON, no markdown fences, no explanation.',
        temperature: 0.7, // Higher creativity
        // maxOutputTokens: 2048
      });

      const schema = z.object({
        keywords: z.array(z.string().min(3).max(100)).min(1).max(50)
      });

      try {
        const parsed = safeJsonParse(raw);
        const validated = schema.parse(parsed);
        const newSeeds = validated.keywords.filter(
          k => !existingSeeds.some(s => s.toLowerCase() === k.toLowerCase())
        );
        // eslint-disable-next-line no-console
        console.log(`[KeywordService] ✅ AI generated ${validated.keywords.length} seeds, ${newSeeds.length} are new`);
        if (newSeeds.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`[KeywordService]    Sample: ${newSeeds.slice(0, 5).join(', ')}...`);
        }
        return newSeeds;
      } catch (parseErr) {
        // eslint-disable-next-line no-console
        console.log('[KeywordService] ⚠️ AI seed parse failed, trying fallback extraction...');
        // Try to extract keywords from the response even if JSON is malformed
        const keywordMatches = raw.match(/"([^"]{3,80})"/g);
        if (keywordMatches && keywordMatches.length > 5) {
          const extracted = keywordMatches
            .map(m => m.replace(/"/g, '').trim())
            .filter(k => k.length > 3 && k.length < 80 && !k.includes(':') && !k.includes('{'))
            .filter(k => !existingSeeds.some(s => s.toLowerCase() === k.toLowerCase()))
            .slice(0, 40);
          if (extracted.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`[KeywordService] ✅ Fallback extracted ${extracted.length} keywords`);
            return extracted;
          }
        }
        // eslint-disable-next-line no-console
        console.log('[KeywordService] ❌ AI seed generation failed to parse response');
        // eslint-disable-next-line no-console
        console.log(`[KeywordService]    Raw response (first 300 chars): ${raw.slice(0, 300)}`);
        return [];
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('[KeywordService] ❌ AI seed generation error:', err);
      return [];
    }
  }

  private buildAiSeedPrompt(
    existingSeeds: string[],
    successfulKeywords: string[],
    postTitles: string[],
    icpProblems: string[] = []
  ): { system: string; user: string } {
    const system = `You are an expert SEO strategist and B2B marketing specialist for a software development consulting business.

Your task is to generate NEW seed keywords that will help discover high-converting blog topics.

CORE PRINCIPLE (from "Sell Money, Not Services"):
- Be a PROBLEM SEEKER, not a service vendor
- "Size of problem = size of budget" — target large, costly business problems
- Every keyword should imply a business problem, not just a service category
- People with bigger problems have bigger budgets. Target the pain first.

The business offers:
- Fractional/Virtual CTO services
- AI/ML consulting and implementation
- Custom software development
- MVP development for startups
- Technical due diligence
- Team augmentation

Target audience:
- Non-technical startup founders
- CTOs scaling their teams
- VPs of Engineering
- Product managers
- Investors doing due diligence

Focus on keywords that indicate:
- Commercial/transactional intent (ready to buy)
- Problem-aware searchers (have a pain point)
- Decision-stage research (comparing options)
- High-value clients (enterprise, funded startups)`;

    const icpSection = icpProblems.length > 0
      ? `\nREAL ICP BUSINESS PROBLEMS (generate seeds targeting these exact pain points):\n${icpProblems.slice(0, 18).map(p => `- ${p}`).join('\n')}\n`
      : '';

    const user = `Generate 40 NEW and UNIQUE seed keywords for SEO content.

SUCCESSFUL PATTERNS FROM OUR DATA:
${successfulKeywords.length > 0 ? `- Keywords that worked: ${successfulKeywords.slice(0, 10).join(', ')}` : '- No data yet'}
${postTitles.length > 0 ? `- Post titles that converted: ${postTitles.slice(0, 5).join(', ')}` : ''}
${icpSection}
AVOID DUPLICATING THESE EXISTING SEEDS (sample):
${existingSeeds.slice(0, 30).join(', ')}

GENERATE KEYWORDS IN THESE CATEGORIES:
1. **Business problems** - The COSTLY PROBLEMS your ICPs face (not the service you sell)
2. **Cost/ROI** - Budget and pricing related searches, cost of inaction
3. **Comparisons** - "X vs Y", "alternatives to X"
4. **How-to** - Educational but with commercial intent
5. **Industry-specific** - Vertical markets (fintech, healthcare, real estate, pharma, logistics, etc.)
6. **Tech stack** - Specific technologies people are struggling with (legacy .NET, Next.js, Node, Postgres, etc.)
7. **Trending** - Current tech trends (AI agents, RAG, on-prem LLM, etc.)
8. **Long-tail transactional** - Very specific buyer searches
9. **Competitor alternatives** - Named competitor keywords
10. **Acquisition/exit prep** - Investors, technical due diligence, exit-ready code

IMPORTANT GUIDELINES:
- Make keywords 3-7 words (long-tail)
- Focus on B2B software development niche
- Include buyer-intent modifiers (services, company, agency, hire, cost, etc.)
- Think about what a buyer types just BEFORE making a purchase decision
- Include some question-based keywords
- Consider voice search patterns
- PRIORITIZE business problem framing over service offering framing

Return JSON only:
{"keywords": ["keyword 1", "keyword 2", ...]}`;

    return { system, user };
  }

  /**
   * Import near-miss keywords from gsc_opportunities into the keywords table.
   * These keywords have proven search demand and get a +60 score boost in topic planning.
   * Returns the number of new keywords inserted.
   */
  async importNearMissKeywords(): Promise<number> {
    // Load pending near-miss opportunities that don't have a dedicated post
    const [opps] = await this.deps.pool.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT o.query, o.website_id, o.metrics_json, w.domain
       FROM gsc_opportunities o
       JOIN websites w ON w.id = o.website_id
       WHERE o.opportunity_type = 'near_miss'
         AND o.status = 'pending'
         AND o.post_id IS NULL
         AND o.query IS NOT NULL
       ORDER BY o.priority ASC
       LIMIT 20`
    );

    if (opps.length === 0) return 0;

    // Avoid importing keywords already in the table
    const [existingRows] = await this.deps.pool.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT keyword FROM keywords`
    );
    const existingSet = new Set((existingRows as { keyword: string }[]).map(r => r.keyword.toLowerCase()));

    let inserted = 0;
    for (const opp of opps as Array<{ query: string; metrics_json: string }>) {
      const keyword = opp.query.trim().toLowerCase();
      if (existingSet.has(keyword)) continue;

      let impressions: number | null = null;
      try {
        const metrics = JSON.parse(opp.metrics_json) as { impressions?: number };
        impressions = metrics.impressions ?? null;
      } catch { /* non-fatal */ }

      const id = crypto.randomUUID();
      const [res] = await this.deps.pool.query<import('mysql2/promise').ResultSetHeader>(
        `INSERT IGNORE INTO keywords
           (id, keyword, volume, difficulty, cpc, intent, status, gsc_sourced, gsc_impressions)
         VALUES (?, ?, ?, 25, ?, 'commercial', 'new', 1, ?)`,
        [id, keyword, impressions ?? 100, 1.5, impressions]
      );
      inserted += res.affectedRows ?? 0;
      existingSet.add(keyword);
    }

    if (inserted > 0) {
      // eslint-disable-next-line no-console
      console.log(`[KeywordService] 📡 Imported ${inserted} near-miss keywords from GSC`);
    }

    return inserted;
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

/**
 * Fisher-Yates shuffle for random seed selection
 */
function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
