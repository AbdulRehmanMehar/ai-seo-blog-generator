import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import crypto from 'node:crypto';

export type SerpProvider = 'serpstack' | 'zenserp' | 'scraperx';

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

function monthString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export class MysqlSerpUsageStore {
  constructor(private readonly pool: MysqlPool) {}

  async getCount(provider: SerpProvider, apiKeyHash: string, monthYear = monthString()): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT request_count FROM serp_usage_monthly WHERE provider = ? AND api_key_hash = ? AND month_year = ?',
      [provider, apiKeyHash, monthYear]
    );
    const row = rows[0] as any;
    const val = row?.request_count;
    return typeof val === 'number' ? val : Number(val ?? 0);
  }

  async increment(provider: SerpProvider, apiKeyHash: string, monthYear = monthString()): Promise<number> {
    await this.pool.query(
      `
      INSERT INTO serp_usage_monthly(provider, api_key_hash, month_year, request_count)
      VALUES (?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP
      `,
      [provider, apiKeyHash, monthYear]
    );
    return this.getCount(provider, apiKeyHash, monthYear);
  }

  async canRequestKey(provider: SerpProvider, apiKeyHash: string, perKeyMonthlyLimit?: number): Promise<boolean> {
    if (!perKeyMonthlyLimit || perKeyMonthlyLimit <= 0) return true;
    const count = await this.getCount(provider, apiKeyHash);
    return count < perKeyMonthlyLimit;
  }

  async pickLeastUsedKey(args: {
    provider: SerpProvider;
    apiKeys: string[];
    perKeyMonthlyLimit?: number;
  }): Promise<{ apiKey: string; apiKeyHash: string; requestCount: number } | null> {
    const keys = [...new Set(args.apiKeys.map((k) => k.trim()).filter(Boolean))];
    if (keys.length === 0) return null;

    const monthYear = monthString();
    const hashes = keys.map((k) => hashApiKey(k));

    // Pull current counts for the month for these hashes.
    const placeholders = hashes.map(() => '?').join(',');
    const sql = `
      SELECT api_key_hash, request_count
      FROM serp_usage_monthly
      WHERE provider = ? AND month_year = ? AND api_key_hash IN (${placeholders})
    `;

    const [rows] = await this.pool.query<RowDataPacket[]>(sql, [args.provider, monthYear, ...hashes]);
    const countByHash = new Map<string, number>();
    for (const r of rows as any[]) {
      const h = String(r.api_key_hash);
      const c = typeof r.request_count === 'number' ? r.request_count : Number(r.request_count ?? 0);
      countByHash.set(h, c);
    }

    let best: { apiKey: string; apiKeyHash: string; requestCount: number } | null = null;
    for (let i = 0; i < keys.length; i++) {
      const apiKey = keys[i]!;
      const apiKeyHash = hashes[i]!;
      const requestCount = countByHash.get(apiKeyHash) ?? 0;
      if (args.perKeyMonthlyLimit && requestCount >= args.perKeyMonthlyLimit) continue;
      if (!best || requestCount < best.requestCount) {
        best = { apiKey, apiKeyHash, requestCount };
      }
    }

    return best;
  }
}
