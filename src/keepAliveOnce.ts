import './config/forceIpv4.js'; // side-effect: must run before any network call
import { postgresPool } from './db/postgresPool.js';
import { pgKeepAlive } from './db/keepAlive.js';

/**
 * One-shot Postgres keep-alive. Compiled to dist/keepAliveOnce.js so it ships in the
 * production Docker image (unlike scripts/pg-keepalive.ts, which lives outside src/).
 * The docker-compose `pg-keepalive` service runs this on an hourly loop so the managed
 * Postgres instance is never suspended for inactivity — independent of the main app.
 */
const ts = new Date().toISOString();
const result = await pgKeepAlive();
if (result.ok) {
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ✓ Postgres keep-alive OK — last_ping = ${result.lastPing}`);
} else {
  // eslint-disable-next-line no-console
  console.error(`[${ts}] ✗ Postgres keep-alive FAILED — ${result.error}`);
}
await postgresPool.end();
process.exit(result.ok ? 0 : 1);
