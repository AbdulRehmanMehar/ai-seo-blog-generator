import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';

export interface GscQueryArgs {
  siteUrl: string;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
  dimensions: Array<'page' | 'query' | 'date' | 'device' | 'country'>;
  rowLimit?: number;
  dimensionFilterGroups?: Array<{
    filters: Array<{
      dimension: string;
      operator: string;
      expression: string;
    }>;
  }>;
}

export interface GscRow {
  page: string;
  query: string;
  date?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscInspectResult {
  url: string;
  indexingState: string;
  lastCrawlTime?: string;
  coverageState?: string;
}

/**
 * Thin wrapper around the Google Search Console API.
 * Authenticates via OAuth2 using the tokens stored in env vars.
 *
 * A single client has access to all GSC properties the authorised user owns,
 * so both primestrides.com and theabdulrehman.com can be queried with the same instance.
 */
export class GscClient {
  private readonly auth: OAuth2Client;

  constructor() {
    this.auth = new google.auth.OAuth2(
      env.GSC_CLIENT_ID,
      env.GSC_CLIENT_SECRET,
      env.GSC_REDIRECT_URI
    ) as OAuth2Client;

    this.auth.setCredentials({
      access_token: env.GSC_ACCESS_TOKEN,
      refresh_token: env.GSC_REFRESH_TOKEN,
      expiry_date: env.GSC_TOKEN_EXPIRY,
    });
  }

  /**
   * Query the GSC Search Analytics API for a specific property.
   * Returns up to `rowLimit` rows (max 25,000 per request).
   */
  async queryPerformance(args: GscQueryArgs): Promise<GscRow[]> {
    const webmasters = google.webmasters({ version: 'v3', auth: this.auth });

    const response = await webmasters.searchanalytics.query({
      siteUrl: args.siteUrl,
      requestBody: {
        startDate: args.startDate,
        endDate: args.endDate,
        dimensions: args.dimensions,
        rowLimit: args.rowLimit ?? 5000,
        dimensionFilterGroups: args.dimensionFilterGroups,
      },
    });

    const rows = response.data.rows ?? [];

    return rows.map((row) => {
      const keys = row.keys ?? [];
      const dimMap: Record<string, string> = {};
      args.dimensions.forEach((dim, i) => {
        dimMap[dim] = keys[i] ?? '';
      });

      return {
        page: dimMap['page'] ?? '',
        query: dimMap['query'] ?? '',
        date: dimMap['date'],
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      };
    });
  }

  /**
   * Inspect a single URL via the URL Inspection API.
   * Use sparingly — aggressive rate limits apply.
   */
  async inspectUrl(siteUrl: string, inspectionUrl: string): Promise<GscInspectResult> {
    const searchconsole = google.searchconsole({ version: 'v1', auth: this.auth });

    const response = await searchconsole.urlInspection.index.inspect({
      requestBody: {
        inspectionUrl,
        siteUrl,
      },
    });

    const result = response.data.inspectionResult;
    const indexStatus = result?.indexStatusResult;

    return {
      url: inspectionUrl,
      indexingState: indexStatus?.indexingState ?? 'UNKNOWN',
      lastCrawlTime: indexStatus?.lastCrawlTime ?? undefined,
      coverageState: indexStatus?.coverageState ?? undefined,
    };
  }
}

/**
 * Returns a GscClient if OAuth2 credentials are configured, otherwise null.
 * Call this wherever you need to interact with GSC — it gracefully handles
 * the case where GSC is not yet set up.
 */
export function buildGscClient(): GscClient | null {
  // Access tokens are intentionally optional — google-auth-library can refresh
  // on demand from the refresh token in fully headless runs.
  if (!env.GSC_CLIENT_ID || !env.GSC_CLIENT_SECRET || !env.GSC_REFRESH_TOKEN) {
    return null;
  }
  return new GscClient();
}
