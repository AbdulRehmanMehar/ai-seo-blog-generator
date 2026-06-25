import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { PublishedPostUrl } from './sitemapService.js';

export interface IndexNowSubmission {
  domain: string;
  submitted: number;
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Submits URLs to IndexNow (https://www.indexnow.org).
 *
 * IMPORTANT CAVEAT: IndexNow notifies Bing, Yandex and Seznam — NOT Google.
 * Google does not consume IndexNow. It is still worthwhile (Bing/Yandex traffic,
 * faster discovery on those engines) and is the only safe, supported "ping a URL"
 * mechanism available without abusing the Google Indexing API (which is officially
 * limited to JobPosting/BroadcastEvent and not appropriate for blog posts).
 *
 * For Google, the legitimate levers are: a served sitemap.xml (see SitemapService),
 * solid internal linking, and earning authority — not a programmatic submit call.
 */
export class IndexNowService {
  private readonly key: string | undefined;
  private readonly outDir: string;

  constructor(key?: string, outDir?: string) {
    this.key = (key ?? env.INDEXNOW_KEY)?.trim() || undefined;
    this.outDir = outDir ?? env.SITEMAP_DIR ?? env.EXPORT_DIR;
  }

  isEnabled(): boolean {
    return Boolean(this.key);
  }

  /**
   * Write the `{key}.txt` verification file into the output dir so it can be
   * deployed to each domain root (IndexNow requires it at https://{host}/{key}.txt).
   */
  async writeKeyFile(): Promise<string | null> {
    if (!this.key) return null;
    await fs.mkdir(this.outDir, { recursive: true });
    const filePath = path.join(this.outDir, `${this.key}.txt`);
    await fs.writeFile(filePath, this.key, 'utf8');
    return filePath;
  }

  /**
   * Submit a batch of URLs to IndexNow, grouped by host (IndexNow requires all
   * URLs in one request to share the same host). Best-effort: failures are
   * captured in the result, never thrown.
   */
  async submitUrls(urls: PublishedPostUrl[]): Promise<IndexNowSubmission[]> {
    if (!this.key || urls.length === 0) return [];

    // Group by host (derived from the URL, not the bare domain, so it matches
    // the scheme/host the key file will be served from).
    const byHost = new Map<string, { host: string; urls: string[] }>();
    for (const u of urls) {
      let host: string;
      try {
        host = new URL(u.url).host;
      } catch {
        continue; // skip malformed URLs
      }
      const group = byHost.get(host) ?? { host, urls: [] };
      group.urls.push(u.url);
      byHost.set(host, group);
    }

    const results: IndexNowSubmission[] = [];
    for (const group of byHost.values()) {
      // IndexNow allows up to 10,000 URLs per request.
      const urlList = group.urls.slice(0, 10_000);
      const body = {
        host: group.host,
        key: this.key,
        keyLocation: `https://${group.host}/${this.key}.txt`,
        urlList
      };

      try {
        const res = await fetch('https://api.indexnow.org/indexnow', {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            accept: 'application/json'
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000)
        });

        // 200 = accepted, 202 = accepted/pending. Both are success.
        const ok = res.status === 200 || res.status === 202;
        results.push({
          domain: group.host,
          submitted: urlList.length,
          ok,
          status: res.status,
          error: ok ? undefined : `IndexNow returned HTTP ${res.status}`
        });
      } catch (err) {
        results.push({
          domain: group.host,
          submitted: urlList.length,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return results;
  }
}
