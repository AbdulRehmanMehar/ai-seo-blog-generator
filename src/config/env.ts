import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  POSTGRES_URL: z.string().min(1),
  MYSQL_URL: z.string().min(1),

  // MySQL/TiDB TLS (TiDB Cloud requires secure transport)
  MYSQL_SSL: z
    .string()
    .optional()
    .transform((v) => {
      if (v == null) return undefined;
      const s = v.trim().toLowerCase();
      if (s === '1' || s === 'true' || s === 'yes') return true;
      if (s === '0' || s === 'false' || s === 'no') return false;
      return undefined;
    }),
  MYSQL_SSL_REJECT_UNAUTHORIZED: z
    .string()
    .optional()
    .transform((v) => {
      if (v == null) return true;
      const s = v.trim().toLowerCase();
      if (s === '0' || s === 'false' || s === 'no') return false;
      return true;
    }),

  // Postgres SSL behavior (some managed providers need rejectUnauthorized=false unless you supply a CA bundle)
  POSTGRES_SSL_REJECT_UNAUTHORIZED: z
    .string()
    .optional()
    .transform((v) => {
      if (v == null) return true;
      const s = v.trim().toLowerCase();
      if (s === '0' || s === 'false' || s === 'no') return false;
      return true;
    }),

  // Optional so `npm run migrate` / `npm run healthcheck` can run without LLM configured.
  // Pipeline execution requires it (validated in orchestrator).
  // Single key (legacy support)
  GEMINI_API_KEY: z.string().min(1).optional(),
  // Multiple keys (comma-separated) - preferred for higher throughput
  GEMINI_API_KEYS: z.string().optional(),
  // Model names - use gemini-2.5-flash for better instruction following
  GEMINI_GENERATION_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),

  // ── Generation provider ──────────────────────────────────────────────
  // Which provider serves text GENERATION. EMBEDDINGS always stay on Gemini
  // (OpenRouter/DeepSeek don't offer embeddings, and Gemini's embedding quota is
  // separate + plentiful). Set LLM_PROVIDER=openrouter (with a key) to escape the
  // Gemini free-tier 20-generations/day cap.
  LLM_PROVIDER: z.enum(['gemini', 'openrouter']).default('gemini'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('deepseek/deepseek-v4-flash'),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),

  CRON_SCHEDULE_1: z.string().default('15 9 * * *'),
  CRON_SCHEDULE_2: z.string().optional(),

  LLM_MIN_SECONDS_BETWEEN_REQUESTS: z.coerce.number().int().positive().default(10),
  // Set to 0 to disable the cap (use with care).
  LLM_DAILY_REQUEST_CAP: z.coerce.number().int().nonnegative().default(20),

  DATAFORSEO_LOGIN: z.string().optional(),
  DATAFORSEO_PASSWORD: z.string().optional(),
  SERPAPI_API_KEY: z.string().optional(),

  // SERP providers (comma-separated lists where applicable)
  SERPSTACK_APIS: z.string().optional(),
  ZENSERP_APIS: z.string().optional(),
  SCRAPPER_X_API: z.string().optional(),

  // Optional monthly request caps for SERP providers
  SERPSTACK_MAX_LIMIT: z.coerce.number().int().positive().optional(),
  ZENSERP_MAX_LIMIT: z.coerce.number().int().positive().optional(),

  // How many posts to generate per pipeline run (default: 2)
  POSTS_PER_RUN: z.coerce.number().int().positive().default(2),

  // Pause NEW article generation while keeping the GSC/GA4 review + refresh/optimization
  // loop running. Set 'true' to freeze new posts (e.g. for a couple of weeks to let the
  // existing library settle / measure an indexing change). Default: off.
  PAUSE_NEW_POSTS: z
    .string()
    .optional()
    .transform((v) => {
      if (v == null) return false;
      const s = v.trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes';
    }),

  // Force outbound DNS to IPv4 (default on). Prevents ETIMEDOUT hangs on hosts with broken
  // IPv6 egress, since Google/OpenRouter resolve IPv6-first. Set 'false' only on IPv6-only hosts.
  FORCE_IPV4: z
    .string()
    .optional()
    .transform((v) => {
      if (v == null) return true;
      const s = v.trim().toLowerCase();
      return !(s === '0' || s === 'false' || s === 'no');
    }),

  // Keyword discovery is GSC-first: import proven-demand near-miss queries first, and only
  // expand via SERP providers when the unused-keyword pool falls below this target.
  KEYWORD_POOL_TARGET: z.coerce.number().int().positive().default(15),

  EXPORT_DIR: z.string().default('./out/posts'),
  POST_MIN_WORDS: z.coerce.number().int().positive().default(1200),
  DUPLICATE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  // Solutions pages share a rigid JSON structure across every niche (same FAQ phrasing
  // patterns, same CTA style), so the baseline similarity between two genuinely different
  // niche pages runs higher than between two free-form blog posts — stricter than the
  // blog's topic-level threshold above, matching ConsolidationService's "same finished
  // asset" bar instead.
  SOLUTIONS_DUPLICATE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.90),
  // Minimum total word count across a solutions page's text fields (headline through
  // cta). Landing pages don't need blog's 1200-word bar, but the first two generated
  // pages (463 and 686 words) read as thin for a page meant to be indexed and ranked —
  // this is a deterministic floor, not just a prompt suggestion the model can ignore.
  SOLUTIONS_MIN_WORDS: z.coerce.number().int().positive().default(900),
  // Reuse a solution's stored SEO research (target_keywords_json) when regenerating its
  // copy, instead of re-querying DataForSEO every time — the underlying search demand
  // doesn't change from one content regeneration to the next. Only re-research when it's
  // this many days old (rankings/volume can genuinely shift), or the pair is brand new.
  SOLUTIONS_SEO_RESEARCH_MAX_AGE_DAYS: z.coerce.number().int().positive().default(30),
  // PIPELINE SWITCH (2026-08-01): the curated solutions matrix is fully written and
  // published (8 niche pages — every pairing the case-study evidence honestly
  // supports), so generation is parked. Approving, publishing, listing, and the
  // sitemap all keep working — only NEW content generation refuses. Set to 'true'
  // when new case studies/niches/services make more pages worth writing.
  SOLUTIONS_GENERATION_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  // KILL SWITCH (2026-08-01): solutions pages no longer use DataForSEO at all —
  // a full-matrix live test proved keyword research structurally can't see the
  // long-tail demand these pages serve (every niche-qualified phrasing measured
  // zero Ads volume; every measurable category term was shopping-intent). The
  // proof gate (case_studies.json niche_fit) + retroactive GSC validation
  // replaced it. researchNicheSeo() refuses to run unless this is explicitly
  // 'true', so no future code path can silently re-introduce paid research here.
  SOLUTIONS_SEO_RESEARCH_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),

  // Target CEFR reading level for generated content. 'A2' (elementary, simple short
  // sentences, ~1500-word vocabulary) is enforced via prompt guidance + deterministic
  // post-processing + a review check. Set to 'none' to disable level enforcement.
  CONTENT_READING_LEVEL: z.enum(['A2', 'B1', 'B2', 'none']).default('A2'),
  // Sentences longer than this many words are flagged as too complex for the target level.
  READING_MAX_SENTENCE_WORDS: z.coerce.number().int().positive().default(22),

  // ── Indexing mechanics ──────────────────────────────────────────────
  // How a post's public URL is built from its website domain + slug.
  // Placeholders: {domain} and {slug}. Override if your blog lives at a
  // different path (e.g. https://{domain}/articles/{slug}).
  BLOG_URL_PATTERN: z.string().default('https://{domain}/blog/{slug}'),
  // Hub-page URL patterns. Placeholders: {domain} and {slug}.
  CATEGORY_URL_PATTERN: z.string().default('https://{domain}/blog/category/{slug}'),
  TAG_URL_PATTERN: z.string().default('https://{domain}/blog/tag/{slug}'),
  // Solutions pages (service x niche landing pages) use a two-slug URL, unlike the
  // single-{slug} patterns above. Placeholders: {domain}, {serviceSlug}, {nicheSlug}.
  SOLUTIONS_URL_PATTERN: z.string().default('https://{domain}/solutions/{serviceSlug}/{nicheSlug}'),
  // Service-level solutions pages (one per service, niche-independent) and the
  // /solutions hub index. Placeholders: {domain}, {serviceSlug}.
  SOLUTIONS_SERVICE_URL_PATTERN: z.string().default('https://{domain}/solutions/{serviceSlug}'),
  SOLUTIONS_HUB_URL_PATTERN: z.string().default('https://{domain}/solutions'),
  // A tag page only becomes indexable / enters the sitemap once it has this many
  // published posts (prevents thin 1-post archive pages). Default: 3.
  TAG_INDEX_MIN_POSTS: z.coerce.number().int().positive().default(3),
  // Max category/tag hub pages to (re)generate unique content for per run (LLM cost cap).
  TAXONOMY_PAGE_CONTENT_PER_RUN: z.coerce.number().int().nonnegative().default(3),
  // Where generated sitemap.xml files are written (one per website).
  // Defaults to EXPORT_DIR when unset.
  SITEMAP_DIR: z.string().optional(),
  // IndexNow key (an 8–128 char hex string). When set, newly published/refreshed
  // URLs are submitted to IndexNow (Bing/Yandex/Seznam — note: Google does NOT
  // consume IndexNow). Leave empty to skip. The matching key file must be hosted
  // at https://{domain}/{key}.txt — we write it into SITEMAP_DIR for deployment.
  INDEXNOW_KEY: z.string().optional(),
  // Submit URLs published/updated within this many days on each run (default: 2).
  INDEXING_LOOKBACK_DAYS: z.coerce.number().int().positive().default(2),
  // Google Indexing API pings on publish/update (2026-08-01). Default on —
  // fails soft (logged, never blocks the pipeline) until the Cloud-side setup
  // is complete (API enabled + service account as OWNER of each GSC property).
  GOOGLE_INDEXING_PING_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  // Max Indexing API pings per pipeline run — headroom under the API's default
  // 200-requests/day project quota even across several cron runs a day.
  GOOGLE_INDEXING_PINGS_PER_RUN: z.coerce.number().int().positive().default(50),

  // GitHub integration for knowledge sync
  GITHUB_PAT: z.string().optional(),
  // Max repos to fetch (default: 100, set 0 for unlimited)
  GITHUB_MAX_REPOS: z.coerce.number().int().nonnegative().default(150),
  // Cron schedule for knowledge sync (default: daily at 3 AM)
  CRON_KNOWLEDGE_SYNC: z.string().default('0 3 * * *'),

  // Postgres keep-alive heartbeat schedule (default: hourly). Lower it (e.g. '*/30 * * * *')
  // if the provider suspends the DB on a shorter inactivity window.
  // Every 30 minutes rather than hourly: the ping is a single tiny write + read, and
  // halving the idle window is cheap insurance against a provider suspending the
  // instance for inactivity. Still honours an explicit CRON_PG_KEEPALIVE if set.
  CRON_PG_KEEPALIVE: z.string().default('*/30 * * * *'),

  // Google service account (PREFERRED for GSC + GA4 — headless, never expires).
  // Three ways to provide it (first one found wins):
  //  (1) Discrete fields from the JSON key — only email + private_key are required:
  GS_client_email: z.string().optional(),
  GS_private_key: z.string().optional(),
  GS_project_id: z.string().optional(),
  //  (2) the full JSON key inline (best for Docker/Portainer)...
  GSC_SERVICE_ACCOUNT_JSON: z.string().optional(),
  //  (3) ...or a path to the JSON key file (best for local dev).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // Google Search Console integration — OAuth2 credentials (legacy fallback if no service account)
  GSC_CLIENT_ID: z.string().optional(),
  GSC_CLIENT_SECRET: z.string().optional(),
  GSC_REDIRECT_URI: z.string().optional(),
  GSC_ACCESS_TOKEN: z.string().optional(),
  GSC_REFRESH_TOKEN: z.string().optional(),
  // Milliseconds since epoch (matches what Google returns)
  GSC_TOKEN_EXPIRY: z.coerce.number().optional(),

  // Google Analytics 4 (GA4) integration
  // Optional global fallback. Prefer per-website `websites.ga4_property_id` when set.
  GA4_PROPERTY_ID: z.string().optional(),
  // Optional per-site env vars (useful when you don't want to store ids in DB)
  GA4_PROPERTY_ID_PRIMESTRIDES: z.string().optional(),
  GA4_PROPERTY_ID_ABDULREHMAN: z.string().optional(),
  // Back-compat aliases (older naming)
  PRIMESTRIDES_GA4_PROPERTY_ID: z.string().optional(),
  ABDULREHMAN_GA4_PROPERTY_ID: z.string().optional(),

  // GSC behaviour thresholds
  // How many days back to pull GSC data per sync (default: 28)
  GSC_SYNC_DAYS_BACK: z.coerce.number().int().positive().default(28),
  // CTR below this fraction triggers title/meta optimization (default: 2%)
  GSC_CTR_THRESHOLD: z.coerce.number().min(0).max(1).default(0.02),
  // Minimum monthly impressions before we act on a page (default: 200)
  GSC_IMPRESSION_MIN: z.coerce.number().int().positive().default(200),
  // Position range defining a "near miss" keyword (default: 5–20)
  GSC_NEAR_MISS_MIN_POSITION: z.coerce.number().positive().default(5),
  GSC_NEAR_MISS_MAX_POSITION: z.coerce.number().positive().default(20),
  // How many positions a page must drop before a refresh is queued (default: 3)
  GSC_DECLINE_POSITION_DELTA: z.coerce.number().positive().default(3)
});

export const env = envSchema.parse(process.env);
