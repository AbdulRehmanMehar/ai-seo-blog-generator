import { postgresPool } from './postgresPool.js';

export interface KeepAliveResult {
  ok: boolean;
  lastPing?: string;
  error?: string;
}

/**
 * Keeps the Postgres instance from being suspended for inactivity by performing a
 * small write + read every time it runs. Maintains a single-row heartbeat table.
 *
 * Best-effort: never throws — returns {ok:false,error} so callers (cron / scripts)
 * can log without crashing.
 */
export async function pgKeepAlive(): Promise<KeepAliveResult> {
  try {
    await postgresPool.query(
      `CREATE TABLE IF NOT EXISTS keepalive_heartbeat (
         id INT PRIMARY KEY,
         last_ping TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    // Write: upsert the single heartbeat row.
    await postgresPool.query(
      `INSERT INTO keepalive_heartbeat (id, last_ping) VALUES (1, now())
       ON CONFLICT (id) DO UPDATE SET last_ping = now()`
    );
    // Read: confirm the value round-trips.
    const res = await postgresPool.query<{ last_ping: string }>(
      `SELECT last_ping FROM keepalive_heartbeat WHERE id = 1`
    );
    return { ok: true, lastPing: res.rows[0]?.last_ping ? String(res.rows[0].last_ping) : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
