import fs from 'node:fs';
import { google } from 'googleapis';
import type { JWT } from 'google-auth-library';
import { env } from '../config/env.js';

/**
 * Shared Google auth for GSC + GA4.
 *
 * Preferred: a SERVICE ACCOUNT (headless, never expires). Configure it via either:
 *   - GSC_SERVICE_ACCOUNT_JSON : the full service-account JSON key as a single-line string
 *     (best for Docker/Portainer — no file to mount), or
 *   - GOOGLE_APPLICATION_CREDENTIALS : a path to the JSON key file (best for local dev).
 *
 * The service-account email must be added as an Owner on each GSC property and a Viewer
 * on each GA4 property.
 *
 * Fallback: the legacy OAuth2 refresh-token flow (fragile — tokens expire/revoke).
 */

// Both scopes on one credential so a single JWT serves GSC and GA4.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

export interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
}

/** Some providers store the PEM with escaped "\n"; turn those back into real newlines. */
function normalizePrivateKey(key: string): string {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

function parseJsonCreds(raw: string): ServiceAccountCreds | null {
  try {
    const p = JSON.parse(raw) as Partial<ServiceAccountCreds>;
    if (p.client_email && p.private_key) return { client_email: p.client_email, private_key: p.private_key };
  } catch { /* not valid JSON */ }
  return null;
}

/**
 * Load service-account credentials. First match wins:
 *   1. Discrete GS_client_email + GS_private_key env vars.
 *   2. GSC_SERVICE_ACCOUNT_JSON (inline JSON).
 *   3. GOOGLE_APPLICATION_CREDENTIALS (path to JSON key file).
 */
export function loadServiceAccount(): ServiceAccountCreds | null {
  const candidates: Array<ServiceAccountCreds | null> = [];

  // 1) Discrete fields (only email + private_key are needed for JWT auth).
  const email = env.GS_client_email?.trim();
  const key = env.GS_private_key?.trim();
  if (email && key) candidates.push({ client_email: email, private_key: key });

  // 2) Inline JSON.
  const inline = env.GSC_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) candidates.push(parseJsonCreds(inline));

  // 3) Key-file path.
  const path = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (path) {
    try { candidates.push(parseJsonCreds(fs.readFileSync(path, 'utf8'))); } catch { /* unreadable */ }
  }

  for (const c of candidates) {
    if (c?.client_email && c?.private_key) {
      return { client_email: c.client_email, private_key: normalizePrivateKey(c.private_key) };
    }
  }
  return null;
}

export function hasServiceAccount(): boolean {
  return loadServiceAccount() !== null;
}

/** Build a JWT auth client for the service account (scoped for GSC + GA4), or null. */
export function buildServiceAccountAuth(): JWT | null {
  const sa = loadServiceAccount();
  if (!sa) return null;
  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: GOOGLE_SCOPES,
  });
}
