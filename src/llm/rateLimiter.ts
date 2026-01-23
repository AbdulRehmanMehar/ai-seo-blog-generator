import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import crypto from 'node:crypto';

export type ModelType = 'generation' | 'embedding';

export interface RateLimits {
  rpm: number;  // Requests per minute
  tpm: number;  // Tokens per minute
  rpd: number;  // Requests per day
}

export interface UsageSnapshot {
  rpm: number;
  tpm: number;
  rpd: number;
}

export interface RateLimitStatus {
  modelType: ModelType;
  limits: RateLimits;
  usage: UsageSnapshot;
  available: {
    rpm: number;
    tpm: number;
    rpd: number;
  };
  canProceed: boolean;
  waitMs: number;  // Suggested wait time if rate limited
  limitReason: 'rpm' | 'tpm' | 'rpd' | null;
}

export interface KeyRateLimitInfo {
  apiKey: string;
  keyHash: string;
  status: RateLimitStatus;
}

interface RateLimitRow extends RowDataPacket {
  model_name: string;
  model_type: ModelType;
  rpm_limit: number;
  tpm_limit: number;
  rpd_limit: number;
}

interface MinuteUsageRow extends RowDataPacket {
  request_count: number;
  token_count: number;
}

interface DailyUsageRow extends RowDataPacket {
  request_count: number;
  token_count: number;
}

/**
 * Comprehensive rate limiter for Gemini API
 * Tracks RPM, TPM, and RPD per API key and model type
 */
export class GeminiRateLimiter {
  private readonly pool: MysqlPool;
  private readonly apiKeys: string[];
  private readonly keyHashes: Map<string, string>;
  
  // Cache rate limits (refresh every 5 minutes)
  private limitsCache: Map<string, RateLimits> = new Map();
  private limitsCacheTime = 0;
  private readonly limitsCacheTtl = 5 * 60 * 1000;

  // Default limits if not in DB (Gemini free tier)
  private readonly defaultLimits: Record<ModelType, RateLimits> = {
    generation: { rpm: 10, tpm: 250000, rpd: 20 },
    embedding: { rpm: 100, tpm: 30000, rpd: 1000 }
  };

  constructor(pool: MysqlPool, apiKeys: string[]) {
    if (apiKeys.length === 0) {
      throw new Error('GeminiRateLimiter: at least one API key is required');
    }
    this.pool = pool;
    this.apiKeys = apiKeys;
    this.keyHashes = new Map();
    
    for (const key of apiKeys) {
      const hash = this.hashKey(key);
      this.keyHashes.set(hash, key);
    }
  }

  private hashKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
  }

  private minuteBucket(now = new Date()): string {
    // Truncate to minute: YYYY-MM-DD HH:MM:00
    const iso = now.toISOString();
    return iso.slice(0, 16).replace('T', ' ') + ':00';
  }

  private dayKey(now = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /**
   * Load rate limits from database (with caching)
   */
  async getRateLimits(modelName: string, modelType: ModelType): Promise<RateLimits> {
    const now = Date.now();
    
    // Refresh cache if expired
    if (now - this.limitsCacheTime > this.limitsCacheTtl) {
      await this.refreshLimitsCache();
    }

    // Check for exact model match first
    const cached = this.limitsCache.get(modelName);
    if (cached) return cached;

    // Fall back to defaults based on model type
    return this.defaultLimits[modelType];
  }

  private async refreshLimitsCache(): Promise<void> {
    const [rows] = await this.pool.query<RateLimitRow[]>(
      'SELECT model_name, model_type, rpm_limit, tpm_limit, rpd_limit FROM llm_rate_limits'
    );

    this.limitsCache.clear();
    for (const row of rows) {
      this.limitsCache.set(row.model_name, {
        rpm: row.rpm_limit,
        tpm: row.tpm_limit,
        rpd: row.rpd_limit
      });
    }
    this.limitsCacheTime = Date.now();
  }

  /**
   * Get current usage for an API key
   */
  async getUsage(apiKey: string, modelType: ModelType): Promise<UsageSnapshot> {
    const hash = this.hashKey(apiKey);
    const minute = this.minuteBucket();
    const day = this.dayKey();

    // Get per-minute usage
    const [minuteRows] = await this.pool.query<MinuteUsageRow[]>(
      `SELECT request_count, token_count FROM llm_usage_minute 
       WHERE minute_bucket = ? AND api_key_hash = ? AND model_type = ?`,
      [minute, hash, modelType]
    );

    // Get daily usage
    const [dailyRows] = await this.pool.query<DailyUsageRow[]>(
      `SELECT request_count, token_count FROM llm_usage_daily 
       WHERE day = ? AND api_key_hash = ? AND model_type = ?`,
      [day, hash, modelType]
    );

    return {
      rpm: minuteRows[0]?.request_count ?? 0,
      tpm: minuteRows[0]?.token_count ?? 0,
      rpd: dailyRows[0]?.request_count ?? 0
    };
  }

  /**
   * Check rate limit status for a key
   */
  async checkRateLimit(
    apiKey: string,
    modelName: string,
    modelType: ModelType,
    estimatedTokens = 0
  ): Promise<RateLimitStatus> {
    const limits = await this.getRateLimits(modelName, modelType);
    const usage = await this.getUsage(apiKey, modelType);

    const available = {
      rpm: Math.max(0, limits.rpm - usage.rpm),
      tpm: Math.max(0, limits.tpm - usage.tpm),
      rpd: Math.max(0, limits.rpd - usage.rpd)
    };

    // Check which limit would be hit
    let limitReason: 'rpm' | 'tpm' | 'rpd' | null = null;
    let canProceed = true;
    let waitMs = 0;

    if (available.rpd <= 0) {
      limitReason = 'rpd';
      canProceed = false;
      // Wait until midnight UTC
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      waitMs = tomorrow.getTime() - now.getTime();
    } else if (available.rpm <= 0) {
      limitReason = 'rpm';
      canProceed = false;
      // Wait until next minute
      const now = new Date();
      waitMs = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    } else if (estimatedTokens > 0 && available.tpm < estimatedTokens) {
      limitReason = 'tpm';
      canProceed = false;
      // Wait until next minute for token refresh
      const now = new Date();
      waitMs = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    }

    return {
      modelType,
      limits,
      usage,
      available,
      canProceed,
      waitMs,
      limitReason
    };
  }

  /**
   * Record usage after a successful request
   */
  async recordUsage(
    apiKey: string,
    modelType: ModelType,
    tokenCount: number
  ): Promise<void> {
    const hash = this.hashKey(apiKey);
    const minute = this.minuteBucket();
    const day = this.dayKey();

    // Update minute tracking
    await this.pool.query(
      `INSERT INTO llm_usage_minute (minute_bucket, api_key_hash, model_type, request_count, token_count)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE 
         request_count = request_count + 1, 
         token_count = token_count + VALUES(token_count)`,
      [minute, hash, modelType, tokenCount]
    );

    // Update daily tracking
    await this.pool.query(
      `INSERT INTO llm_usage_daily (day, api_key_hash, model_type, request_count, token_count)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE 
         request_count = request_count + 1, 
         token_count = token_count + VALUES(token_count),
         updated_at = CURRENT_TIMESTAMP`,
      [day, hash, modelType, tokenCount]
    );
  }

  /**
   * Select the best API key for a request
   * Returns the key with most available capacity
   */
  async selectBestKey(
    modelName: string,
    modelType: ModelType,
    estimatedTokens = 0
  ): Promise<KeyRateLimitInfo | null> {
    const candidates: KeyRateLimitInfo[] = [];

    for (const [hash, apiKey] of this.keyHashes) {
      const status = await this.checkRateLimit(apiKey, modelName, modelType, estimatedTokens);
      if (status.canProceed) {
        candidates.push({ apiKey, keyHash: hash, status });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sort by: most RPD available, then most RPM available
    candidates.sort((a, b) => {
      // Prioritize keys with more daily capacity remaining
      const rpdDiff = b.status.available.rpd - a.status.available.rpd;
      if (rpdDiff !== 0) return rpdDiff;
      // Then by per-minute capacity
      return b.status.available.rpm - a.status.available.rpm;
    });

    return candidates[0]!;
  }

  /**
   * Wait if rate limited, then proceed
   * Returns the selected key info
   */
  async waitForAvailableKey(
    modelName: string,
    modelType: ModelType,
    estimatedTokens = 0,
    maxWaitMs = 120000  // 2 minutes max wait
  ): Promise<KeyRateLimitInfo> {
    const startTime = Date.now();

    while (true) {
      const keyInfo = await this.selectBestKey(modelName, modelType, estimatedTokens);
      
      if (keyInfo) {
        return keyInfo;
      }

      // No keys available, find shortest wait time
      let minWait = Infinity;
      for (const apiKey of this.apiKeys) {
        const status = await this.checkRateLimit(apiKey, modelName, modelType, estimatedTokens);
        if (status.waitMs < minWait && status.limitReason !== 'rpd') {
          minWait = status.waitMs;
        }
      }

      // Check if all keys hit daily cap
      if (minWait === Infinity) {
        throw new Error(
          `All ${this.apiKeys.length} API keys have hit their daily limit (RPD). ` +
          `Try again tomorrow or add more API keys.`
        );
      }

      // Check max wait time
      const elapsed = Date.now() - startTime;
      if (elapsed + minWait > maxWaitMs) {
        throw new Error(
          `Rate limited: would need to wait ${Math.ceil(minWait / 1000)}s, ` +
          `exceeds max wait time of ${Math.ceil(maxWaitMs / 1000)}s`
        );
      }

      // Wait for rate limit to reset
      console.log(`[RateLimiter] All keys rate limited. Waiting ${Math.ceil(minWait / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, minWait + 1000)); // +1s buffer
    }
  }

  /**
   * Get usage summary for all keys
   */
  async getUsageSummary(): Promise<string> {
    const day = this.dayKey();
    const parts: string[] = [];

    for (const [hash, apiKey] of this.keyHashes) {
      const genUsage = await this.getUsage(apiKey, 'generation');
      const embUsage = await this.getUsage(apiKey, 'embedding');
      
      parts.push(
        `Key ${hash.slice(0, 4)}...: gen=${genUsage.rpd}/day, emb=${embUsage.rpd}/day`
      );
    }

    return parts.join(' | ');
  }

  /**
   * Cleanup old minute-level data (keep last 2 hours)
   */
  async cleanupOldData(): Promise<number> {
    const [result] = await this.pool.query(
      `DELETE FROM llm_usage_minute WHERE minute_bucket < DATE_SUB(NOW(), INTERVAL 2 HOUR)`
    );
    return (result as any)?.affectedRows ?? 0;
  }

  get keyCount(): number {
    return this.apiKeys.length;
  }
}
