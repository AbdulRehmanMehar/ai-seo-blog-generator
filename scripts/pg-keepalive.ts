/**
 * POSTGRES KEEP-ALIVE (standalone)
 *
 * Writes + reads a single-row heartbeat table so the managed Postgres instance is not
 * suspended for inactivity. Run this from an EXTERNAL scheduler (system crontab, a
 * Portainer/Render/GitHub-Actions scheduled job) so it keeps the DB alive even when the
 * main app is not running.
 *
 * Example crontab (every hour):
 *   0 * * * * cd /path/to/app && /usr/bin/npx tsx scripts/pg-keepalive.ts >> /var/log/pg-keepalive.log 2>&1
 *
 * Run: npx tsx scripts/pg-keepalive.ts   (or: npm run keepalive)
 */
import 'dotenv/config';
import dns from 'node:dns';
// Force IPv4 — some hosts (and managed DB providers) hand out IPv6 first while this
// environment's IPv6 egress is broken, causing connect timeouts.
dns.setDefaultResultOrder('ipv4first');
const _origLookup = dns.lookup;
(dns as any).lookup = function (hostname: string, options: any, callback: any) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  opts.family = 4;
  return (_origLookup as any)(hostname, opts, callback);
};
import { postgresPool } from '../src/db/postgresPool.js';
import { pgKeepAlive } from '../src/db/keepAlive.js';

const ts = new Date().toISOString();
const result = await pgKeepAlive();
if (result.ok) {
  console.log(`[${ts}] ✓ Postgres keep-alive OK — last_ping = ${result.lastPing}`);
} else {
  console.error(`[${ts}] ✗ Postgres keep-alive FAILED — ${result.error}`);
}
await postgresPool.end();
process.exit(result.ok ? 0 : 1);
