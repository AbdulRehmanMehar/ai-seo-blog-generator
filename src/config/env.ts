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

  EXPORT_DIR: z.string().default('./out/posts'),
  POST_MIN_WORDS: z.coerce.number().int().positive().default(1200),
  DUPLICATE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  // GitHub integration for knowledge sync
  GITHUB_PAT: z.string().optional(),
  // Max repos to fetch (default: 100, set 0 for unlimited)
  GITHUB_MAX_REPOS: z.coerce.number().int().nonnegative().default(150),
  // Cron schedule for knowledge sync (default: daily at 3 AM)
  CRON_KNOWLEDGE_SYNC: z.string().default('0 3 * * *'),

  // Google Search Console integration — OAuth2 credentials
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
