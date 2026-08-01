/**
 * Google Indexing API client ("Web Search Indexing API" in the Cloud Console) —
 * pings Google that a URL was updated so it gets queued for recrawl, usually
 * within hours instead of whenever the sitemap next gets re-fetched.
 *
 * Uses the SAME service account as the Search Console integration
 * (googleAuth.ts / loadServiceAccount), but its own JWT: the Indexing API needs
 * the dedicated `auth/indexing` scope, and the service account must be an
 * OWNER (not just a user) of the Search Console property being pinged.
 *
 * Caveats, acknowledged with the user (2026-08-01) before this was built:
 * Google officially scopes this API to JobPosting/BroadcastEvent pages and says
 * it may de-prioritize pings for other content. Default quota: 200
 * publish requests per day per Cloud project, shared across all properties.
 */
import { google } from 'googleapis';
import type { JWT } from 'google-auth-library';
import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import { loadServiceAccount } from './googleAuth.js';

const INDEXING_SCOPE = ['https://www.googleapis.com/auth/indexing'];

export interface IndexingPingResult {
  url: string;
  ok: boolean;
  /** Google's echo of the notification on success, or the error message on failure. */
  detail: string;
}

export interface IndexingBatchResult {
  pinged: number;
  /** Already pinged since their last content change — quota saved, nothing sent. */
  skipped: number;
  failed: number;
  /** Set when the batch aborted early on a setup/quota error (permission, API disabled, 429). */
  abortReason?: string;
}

export class GoogleIndexingService {
  private readonly auth: JWT;

  private constructor(auth: JWT) {
    this.auth = auth;
  }

  static build(): GoogleIndexingService | null {
    const sa = loadServiceAccount();
    if (!sa) return null;
    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: INDEXING_SCOPE,
    });
    return new GoogleIndexingService(auth);
  }

  /** Notify Google that one URL was added or updated (type URL_UPDATED). */
  async pingUrlUpdated(url: string): Promise<IndexingPingResult> {
    const indexing = google.indexing({ version: 'v3', auth: this.auth });
    try {
      const res = await indexing.urlNotifications.publish({
        requestBody: { url, type: 'URL_UPDATED' },
      });
      const notified = res.data.urlNotificationMetadata?.latestUpdate?.notifyTime ?? 'accepted';
      return { url, ok: true, detail: String(notified) };
    } catch (err) {
      return { url, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Quota-safe batch used by the pipeline: pings only URLs whose content changed
   * since their last recorded ping (google_indexing_pings ledger), records each
   * success, and aborts the whole batch on the first setup/quota-class error
   * (permission denied / API disabled / 429) so a misconfiguration never burns
   * the daily quota on guaranteed failures. Never throws.
   */
  async pingUpdatedUrls(
    pool: MysqlPool,
    urls: Array<{ url: string; lastmod: string }>,
    cap: number
  ): Promise<IndexingBatchResult> {
    const out: IndexingBatchResult = { pinged: 0, skipped: 0, failed: 0 };
    if (urls.length === 0) return out;

    const unique = [...new Map(urls.map((u) => [u.url, u])).values()];
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT url, last_pinged_at FROM google_indexing_pings WHERE url IN (${unique.map(() => '?').join(',')})`,
      unique.map((u) => u.url)
    );
    const lastPinged = new Map((rows as any[]).map((r) => [String(r.url), new Date(r.last_pinged_at)]));

    const due = unique.filter((u) => {
      const prev = lastPinged.get(u.url);
      // Ping when never pinged, or when the content changed on a LATER day than
      // the last ping. Strictly-after on purpose: lastmod is date-granular, so
      // ">=" would re-ping every URL on every cron run all day (same-day update
      // + same-day ping) — the exact quota burn this ledger exists to prevent.
      // Cost: a second update on the SAME day as a ping waits for the next
      // day's change to be re-announced. Fine — sitemap lastmod still covers it.
      if (!prev) return true;
      return u.lastmod > prev.toISOString().slice(0, 10);
    });
    out.skipped = unique.length - due.length;

    for (const u of due.slice(0, cap)) {
      const res = await this.pingUrlUpdated(u.url);
      if (res.ok) {
        out.pinged++;
        await pool.query(
          `INSERT INTO google_indexing_pings (url, last_pinged_at) VALUES (?, NOW())
           ON DUPLICATE KEY UPDATE last_pinged_at = NOW()`,
          [u.url]
        );
      } else {
        out.failed++;
        const msg = res.detail.toLowerCase();
        if (msg.includes('permission') || msg.includes('disabled') || msg.includes('has not been used') || msg.includes('quota') || msg.includes('429')) {
          out.abortReason = res.detail;
          break;
        }
      }
    }
    return out;
  }
}
