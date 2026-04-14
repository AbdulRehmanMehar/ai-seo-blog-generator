import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { env } from '../config/env.js';

export interface Ga4PageEngagementRow {
  page: string; // pagePath
  views: number;
  avgEngagementSec: number;
  bounceRate: number; // 0-1
  newUsers: number;
  returningUsers: number;
}

export interface Ga4OrganicLandingPageRow {
  page: string; // landingPage
  sessions: number;
  bounceRate: number; // 0-1
  avgEngagementSec: number;
}

export class Ga4Client {
  private readonly propertyId: string;
  private readonly client: BetaAnalyticsDataClient;

  constructor(args: { propertyId: string }) {
    this.propertyId = args.propertyId;

    // Reuse the same OAuth2 refresh token as GSC.
    const auth = new google.auth.OAuth2(
      env.GSC_CLIENT_ID,
      env.GSC_CLIENT_SECRET,
      env.GSC_REDIRECT_URI
    ) as OAuth2Client;

    auth.setCredentials({
      refresh_token: env.GSC_REFRESH_TOKEN,
      access_token: env.GSC_ACCESS_TOKEN,
      expiry_date: env.GSC_TOKEN_EXPIRY,
    });

    this.client = new BetaAnalyticsDataClient({ authClient: auth as any });
  }

  private propertyName(): string {
    return `properties/${this.propertyId}`;
  }

  async getPageEngagement(args?: { daysBack?: number }): Promise<Ga4PageEngagementRow[]> {
    const daysBack = args?.daysBack ?? 90;
    const { startDate, endDate } = getDateRange(daysBack);

    const [res] = await this.client.runReport({
      property: this.propertyName(),
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'averageSessionDuration' },
        { name: 'bounceRate' },
        { name: 'newUsers' },
        { name: 'returningUsers' },
      ],
      metricAggregations: [],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 20,
    });

    const rows = res.rows ?? [];
    const mapped = rows
      .map((r): Ga4PageEngagementRow | null => {
        const page = r.dimensionValues?.[0]?.value ?? '';
        const views = toNumber(r.metricValues?.[0]?.value);
        const avgEngagementSec = toNumber(r.metricValues?.[1]?.value);
        const bounceRate = toNumber(r.metricValues?.[2]?.value);
        const newUsers = toNumber(r.metricValues?.[3]?.value);
        const returningUsers = toNumber(r.metricValues?.[4]?.value);
        if (!page) return null;
        if (views < 10) return null;
        return { page, views, avgEngagementSec, bounceRate, newUsers, returningUsers };
      })
      .filter((x): x is Ga4PageEngagementRow => x !== null);

    return mapped;
  }

  async getTopLandingPages(args?: { daysBack?: number }): Promise<Ga4OrganicLandingPageRow[]> {
    const daysBack = args?.daysBack ?? 90;
    const { startDate, endDate } = getDateRange(daysBack);

    const [res] = await this.client.runReport({
      property: this.propertyName(),
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 20,
    });

    const rows = res.rows ?? [];
    return rows
      .map((r): Ga4OrganicLandingPageRow | null => {
        const page = r.dimensionValues?.[0]?.value ?? '';
        const sessions = toNumber(r.metricValues?.[0]?.value);
        const bounceRate = toNumber(r.metricValues?.[1]?.value);
        const avgEngagementSec = toNumber(r.metricValues?.[2]?.value);
        if (!page) return null;
        return { page, sessions, bounceRate, avgEngagementSec };
      })
      .filter((x): x is Ga4OrganicLandingPageRow => x !== null);
  }
}

export function buildGa4Client(propertyId?: string | null): Ga4Client | null {
  const pid = (propertyId ?? env.GA4_PROPERTY_ID ?? '').trim();
  if (!pid) return null;

  // Requires shared OAuth2 credentials (same as GSC).
  if (!env.GSC_CLIENT_ID || !env.GSC_CLIENT_SECRET || !env.GSC_REFRESH_TOKEN) return null;

  return new Ga4Client({ propertyId: pid });
}

export function resolveGa4PropertyIdForDomain(domain: string | null | undefined): string | null {
  const d = (domain ?? '').toLowerCase();
  if (d.includes('primestrides')) {
    const v = env.GA4_PROPERTY_ID_PRIMESTRIDES ?? env.PRIMESTRIDES_GA4_PROPERTY_ID;
    if (v) return v.trim();
  }
  if (d.includes('theabdulrehman')) {
    const v = env.GA4_PROPERTY_ID_ABDULREHMAN ?? env.ABDULREHMAN_GA4_PROPERTY_ID;
    if (v) return v.trim();
  }
  return env.GA4_PROPERTY_ID?.trim() || null;
}

function toNumber(v: string | null | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getDateRange(daysBack: number): { startDate: string; endDate: string } {
  const now = new Date();
  const end = new Date(now.getTime() - 1 * 86400000); // GA is often delayed; use "yesterday"
  const start = new Date(end.getTime() - daysBack * 86400000);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

