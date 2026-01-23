import type { Pool } from 'pg';
import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';

export interface LlmUsageStore {
  getCount(day: string): Promise<number>;
  increment(day: string): Promise<number>;
}

/**
 * Persists daily request counts so the safety cap survives process restarts.
 * `day` format: YYYY-MM-DD
 */
export class PostgresLlmUsageStore implements LlmUsageStore {
  constructor(private readonly pool: Pool) {}

  async getCount(day: string): Promise<number> {
    const res = await this.pool.query<{ request_count: number }>(
      `SELECT request_count FROM llm_usage_daily WHERE day = $1::date`,
      [day]
    );
    return res.rows[0]?.request_count ?? 0;
  }

  async increment(day: string): Promise<number> {
    const res = await this.pool.query<{ request_count: number }>(
      `
      INSERT INTO llm_usage_daily(day, request_count)
      VALUES ($1::date, 1)
      ON CONFLICT (day)
      DO UPDATE SET request_count = llm_usage_daily.request_count + 1, updated_at = now()
      RETURNING request_count
      `,
      [day]
    );

    const count = res.rows[0]?.request_count;
    if (count == null) throw new Error('LlmUsageStore: increment did not return request_count');
    return count;
  }
}

/**
 * MySQL implementation used when MySQL stores content/stats.
 * `day` format: YYYY-MM-DD
 */
export class MysqlLlmUsageStore implements LlmUsageStore {
  constructor(private readonly pool: MysqlPool) {}

  async getCount(day: string): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT request_count FROM llm_usage_daily WHERE day = ?', [day]);
    const row = rows[0] as any;
    const val = row?.request_count;
    return typeof val === 'number' ? val : Number(val ?? 0);
  }

  async increment(day: string): Promise<number> {
    await this.pool.query(
      `
      INSERT INTO llm_usage_daily(day, request_count)
      VALUES (?, 1)
      ON DUPLICATE KEY UPDATE request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP
      `,
      [day]
    );
    return this.getCount(day);
  }
}
