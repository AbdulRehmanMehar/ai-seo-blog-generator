import { postgresPool } from './postgresPool.js';

export interface KeepAliveResult {
  ok: boolean;
  lastPing?: string;
  /** Total successful pings ever recorded — proves the loop is actually running. */
  pingCount?: number;
  /** Consecutive failures observed by THIS process (in-memory; survives DB outages). */
  consecutiveFailures?: number;
  /** Rows read from a real application table, so the ping is genuine data activity. */
  embeddingsSeen?: number;
  attempts?: number;
  error?: string;
}

/**
 * In-memory failure counter. The DB is exactly what is unavailable when a ping fails,
 * so failure state cannot be persisted there — it has to live in the process.
 */
let consecutiveFailures = 0;

const RETRIES = 3;
const RETRY_DELAY_MS = 4000;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps the managed Postgres instance from being suspended for inactivity, and records
 * enough state to PROVE it has been running.
 *
 * Why the extra columns: the original version maintained a single row holding only
 * last_ping. That makes "is the keep-alive actually running?" unanswerable after the
 * fact — a last_ping value is equally consistent with an hourly loop and with one write
 * months ago. ping_count and last_error turn it into evidence: a count climbing by ~48/day
 * proves the loop is alive, and a stalled count localises the failure immediately.
 *
 * Why it reads a real table: a heartbeat table the app never otherwise touches is a
 * synthetic signal. Reading `embeddings` (the reason this database exists) guarantees the
 * ping exercises real data, not just a private scratch row.
 *
 * Why it retries: a single transient network blip previously meant a whole hour with no
 * activity at all. Three attempts with a short backoff make one bad moment survivable.
 *
 * Best-effort: never throws — returns {ok:false,error} so cron callers can log without
 * risking an unhandled rejection.
 */
export async function pgKeepAlive(): Promise<KeepAliveResult> {
  let lastError = '';

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      await postgresPool.query(
        `CREATE TABLE IF NOT EXISTS keepalive_heartbeat (
           id INT PRIMARY KEY,
           last_ping TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      // Additive migration for instances created before these columns existed.
      await postgresPool.query(
        `ALTER TABLE keepalive_heartbeat
           ADD COLUMN IF NOT EXISTS ping_count BIGINT NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS last_error TEXT,
           ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ`
      );

      // Write: bump the heartbeat and the running total.
      await postgresPool.query(
        `INSERT INTO keepalive_heartbeat (id, last_ping, ping_count)
         VALUES (1, now(), 1)
         ON CONFLICT (id) DO UPDATE
           SET last_ping = now(),
               ping_count = keepalive_heartbeat.ping_count + 1`
      );

      // Read back the heartbeat AND touch a real application table in the same tick,
      // so the instance sees genuine query activity against its actual data.
      const res = await postgresPool.query<{ last_ping: string; ping_count: string }>(
        `SELECT last_ping, ping_count FROM keepalive_heartbeat WHERE id = 1`
      );
      let embeddingsSeen: number | undefined;
      try {
        const emb = await postgresPool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM embeddings`);
        embeddingsSeen = Number(emb.rows[0]?.count ?? 0);
      } catch {
        // embeddings table may not exist on a fresh instance — the heartbeat still counts
      }

      consecutiveFailures = 0;
      return {
        ok: true,
        lastPing: res.rows[0]?.last_ping ? String(res.rows[0].last_ping) : undefined,
        pingCount: Number(res.rows[0]?.ping_count ?? 0),
        consecutiveFailures: 0,
        embeddingsSeen,
        attempts: attempt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < RETRIES) await delay(RETRY_DELAY_MS);
    }
  }

  consecutiveFailures++;
  // Best-effort: if the instance is reachable again later, leave a breadcrumb explaining
  // the gap in ping_count. Silently ignored while it is still down.
  try {
    await postgresPool.query(
      `UPDATE keepalive_heartbeat SET last_error = $1, last_error_at = now() WHERE id = 1`,
      [lastError.slice(0, 500)]
    );
  } catch { /* still unreachable — nothing to record against */ }

  return { ok: false, error: lastError, consecutiveFailures, attempts: RETRIES };
}
