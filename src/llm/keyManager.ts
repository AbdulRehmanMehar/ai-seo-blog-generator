import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import crypto from 'node:crypto';

export interface KeyUsageInfo {
  apiKey: string;
  keyHash: string;
  usageToday: number;
}

export interface GeminiKeyManagerOptions {
  apiKeys: string[];
  dailyCapPerKey: number;
  pool: MysqlPool;
}

/**
 * Manages multiple Gemini API keys with intelligent selection.
 * Tracks usage per key and selects the least-used key that hasn't hit its cap.
 */
export class GeminiKeyManager {
  private readonly apiKeys: string[];
  private readonly keyHashes: Map<string, string>; // hash -> apiKey
  private readonly dailyCapPerKey: number;
  private readonly pool: MysqlPool;

  constructor(opts: GeminiKeyManagerOptions) {
    if (opts.apiKeys.length === 0) {
      throw new Error('GeminiKeyManager: at least one API key is required');
    }
    this.apiKeys = opts.apiKeys;
    this.dailyCapPerKey = opts.dailyCapPerKey;
    this.pool = opts.pool;

    // Create hash map for quick lookups
    this.keyHashes = new Map();
    for (const key of this.apiKeys) {
      const hash = this.hashKey(key);
      this.keyHashes.set(hash, key);
    }
  }

  /**
   * Create a short hash of the API key for storage/display (first 8 chars of SHA256)
   */
  private hashKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
  }

  /**
   * Get the day key in YYYY-MM-DD format
   */
  private dayKey(now = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /**
   * Get usage counts for all keys for a given day
   */
  async getUsageForDay(day: string): Promise<Map<string, number>> {
    const hashes = Array.from(this.keyHashes.keys());
    const placeholders = hashes.map(() => '?').join(',');

    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT api_key_hash, request_count FROM llm_usage_daily WHERE day = ? AND api_key_hash IN (${placeholders})`,
      [day, ...hashes]
    );

    const usageMap = new Map<string, number>();
    // Initialize all keys with 0
    for (const hash of hashes) {
      usageMap.set(hash, 0);
    }
    // Fill in actual counts
    for (const row of rows) {
      usageMap.set(row.api_key_hash, Number(row.request_count));
    }

    return usageMap;
  }

  /**
   * Get usage for a specific key
   */
  async getKeyUsage(apiKey: string, day?: string): Promise<number> {
    const hash = this.hashKey(apiKey);
    const targetDay = day ?? this.dayKey();

    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT request_count FROM llm_usage_daily WHERE day = ? AND api_key_hash = ?',
      [targetDay, hash]
    );

    return Number(rows[0]?.request_count ?? 0);
  }

  /**
   * Increment usage for a specific key
   */
  async incrementKeyUsage(apiKey: string, day?: string): Promise<number> {
    const hash = this.hashKey(apiKey);
    const targetDay = day ?? this.dayKey();

    await this.pool.query(
      `INSERT INTO llm_usage_daily (day, api_key_hash, request_count)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP`,
      [targetDay, hash]
    );

    return this.getKeyUsage(apiKey, targetDay);
  }

  /**
   * Select the best API key to use based on:
   * 1. Keys that haven't hit their daily cap
   * 2. Among available keys, select the one with lowest usage (load balancing)
   *
   * Returns null if all keys have hit their cap.
   */
  async selectBestKey(): Promise<KeyUsageInfo | null> {
    const day = this.dayKey();
    const usageMap = await this.getUsageForDay(day);

    // Find keys that haven't hit their cap
    const availableKeys: Array<{ apiKey: string; hash: string; usage: number }> = [];

    for (const [hash, apiKey] of this.keyHashes) {
      const usage = usageMap.get(hash) ?? 0;
      if (this.dailyCapPerKey === 0 || usage < this.dailyCapPerKey) {
        availableKeys.push({ apiKey, hash, usage });
      }
    }

    if (availableKeys.length === 0) {
      return null; // All keys exhausted
    }

    // Sort by usage (ascending) to get least-used key
    availableKeys.sort((a, b) => a.usage - b.usage);

    const selected = availableKeys[0]!;
    return {
      apiKey: selected.apiKey,
      keyHash: selected.hash,
      usageToday: selected.usage
    };
  }

  /**
   * Check if any keys are available (haven't hit cap)
   */
  async hasAvailableKeys(): Promise<boolean> {
    const key = await this.selectBestKey();
    return key !== null;
  }

  /**
   * Get total usage across all keys for today
   */
  async getTotalUsageToday(): Promise<number> {
    const day = this.dayKey();
    const usageMap = await this.getUsageForDay(day);
    let total = 0;
    for (const count of usageMap.values()) {
      total += count;
    }
    return total;
  }

  /**
   * Get combined daily cap (sum of all key caps)
   */
  get totalDailyCap(): number {
    if (this.dailyCapPerKey === 0) return 0; // Unlimited
    return this.dailyCapPerKey * this.apiKeys.length;
  }

  /**
   * Get number of configured keys
   */
  get keyCount(): number {
    return this.apiKeys.length;
  }

  /**
   * Get usage summary for logging
   */
  async getUsageSummary(): Promise<string> {
    const day = this.dayKey();
    const usageMap = await this.getUsageForDay(day);
    const parts: string[] = [];

    for (const [hash, count] of usageMap) {
      const cap = this.dailyCapPerKey === 0 ? '∞' : this.dailyCapPerKey;
      parts.push(`${hash.slice(0, 4)}...: ${count}/${cap}`);
    }

    return parts.join(' | ');
  }
}

/**
 * Parse API keys from environment variables.
 * Supports both single key (GEMINI_API_KEY) and multiple keys (GEMINI_API_KEYS).
 */
export function parseGeminiApiKeys(singleKey?: string, multipleKeys?: string): string[] {
  const keys: string[] = [];

  // Parse comma-separated keys first (preferred)
  if (multipleKeys) {
    const parsed = multipleKeys
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    keys.push(...parsed);
  }

  // Add single key if not already present
  if (singleKey && !keys.includes(singleKey)) {
    keys.push(singleKey);
  }

  return keys;
}
