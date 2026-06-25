import dns from 'node:dns';
import { env } from './env.js';

/**
 * Some hosts / deploy environments have broken IPv6 egress, while Google
 * (oauth2.googleapis.com), OpenRouter, and managed DB endpoints resolve to IPv6 first.
 * Node's HTTP clients (notably the node-fetch used by google-auth-library) don't fall back
 * to IPv4 like curl does, so they hang with ETIMEDOUT. Forcing IPv4 avoids this.
 *
 * All endpoints this app talks to (Google APIs, OpenRouter, TiDB, Postgres) have IPv4 (A)
 * records, so this is safe. Set FORCE_IPV4=false to disable (e.g. an IPv6-only host).
 *
 * Imported for its SIDE EFFECT — must be the FIRST import in the entrypoints so the
 * override is installed before any network call.
 */
if (env.FORCE_IPV4) {
  dns.setDefaultResultOrder('ipv4first');
  const original = dns.lookup;
  (dns as any).lookup = function (hostname: string, options: any, callback: any) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
    opts.family = 4;
    return (original as any)(hostname, opts, callback);
  };
  // eslint-disable-next-line no-console
  console.log('[net] IPv4 forced for outbound DNS (FORCE_IPV4=true)');
}
