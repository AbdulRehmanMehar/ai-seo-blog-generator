import { buildGscClient, type GscRow } from './gscClient.js';
import { buildGa4Client, type Ga4PageEngagementRow } from './ga4Client.js';

export type OpportunityBucket = 'write_new' | 'fix_meta' | 'improve_content' | 'double_down';

export interface KeywordOpportunity {
  query: string;
  page: string;
  impressions: number;
  position: number;
}

export interface TopQuery {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface EnrichedOpportunity extends KeywordOpportunity {
  avgEngagementSec: number | null;
  bounceRate: number | null;
  hasTraffic: boolean;
  bucket: OpportunityBucket;
}

export class ContentBriefService {
  async generateContentBrief(args: {
    siteUrl: string; // e.g. sc-domain:primestrides.com or https://www.primestrides.co
    ga4PropertyId?: string | null;
    daysBack?: number;
  }): Promise<string> {
    const daysBack = args.daysBack ?? 90;

    const gsc = buildGscClient();
    const ga4 = buildGa4Client(args.ga4PropertyId);

    const timestamp = new Date().toISOString();
    const headerLines = [
      '=== PRIME SCRIBE CONTENT INTELLIGENCE BRIEF ===',
      `Generated: ${timestamp}`,
      `Data range: Last ${daysBack} days`,
      `Site: ${args.siteUrl}`,
      '',
    ];

    const gscEnabled = Boolean(gsc);
    const gaEnabled = Boolean(ga4);

    if (!gscEnabled && !gaEnabled) {
      throw new Error(
        'ContentBriefService: neither GSC nor GA4 is configured. Set GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN and GA4_PROPERTY_ID (or websites.ga4_property_id).'
      );
    }

    const { startDate, endDate } = getGscDateRange(daysBack);

    const tasks = {
      opportunities: gsc
        ? getKeywordOpportunities(gsc, { siteUrl: args.siteUrl, startDate, endDate })
        : Promise.resolve([] as KeywordOpportunity[]),
      topQueries: gsc
        ? getTopPerformingQueries(gsc, { siteUrl: args.siteUrl, startDate, endDate })
        : Promise.resolve([] as TopQuery[]),
      pageEngagement: ga4 ? ga4.getPageEngagement({ daysBack }) : Promise.resolve([] as Ga4PageEngagementRow[]),
      landingPages: ga4 ? ga4.getTopLandingPages({ daysBack }) : Promise.resolve([]),
    };

    let opportunities: KeywordOpportunity[] = [];
    let topQueries: TopQuery[] = [];
    let pageEngagement: Ga4PageEngagementRow[] = [];

    try {
      const results = await Promise.allSettled([
        tasks.opportunities,
        tasks.topQueries,
        tasks.pageEngagement,
        tasks.landingPages,
      ]);

      const [oppRes, topRes, peRes, lpRes] = results;

      if (oppRes.status === 'fulfilled') opportunities = oppRes.value;
      if (topRes.status === 'fulfilled') topQueries = topRes.value;
      if (peRes.status === 'fulfilled') pageEngagement = peRes.value;

      const gscFailed = (oppRes.status === 'rejected' || topRes.status === 'rejected') && gscEnabled;
      const gaFailed = (peRes.status === 'rejected' || lpRes.status === 'rejected') && gaEnabled;

      if (gscFailed && gaFailed) {
        const gscErr = oppRes.status === 'rejected' ? oppRes.reason : topRes.status === 'rejected' ? topRes.reason : null;
        const gaErr = peRes.status === 'rejected' ? peRes.reason : lpRes.status === 'rejected' ? lpRes.reason : null;
        throw new Error(
          `ContentBriefService: both GSC and GA4 calls failed. GSC error: ${formatErr(gscErr)} | GA4 error: ${formatErr(gaErr)}`
        );
      }
    } catch (err) {
      // Propagate as requested (descriptive).
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ContentBriefService: failed to generate brief. ${msg}`);
    }

    const engagementByPath = new Map<string, Ga4PageEngagementRow>();
    for (const row of pageEngagement) {
      engagementByPath.set(normalizePath(row.page), row);
    }

    const topQueriesSet = new Set(topQueries.map((t) => t.query.toLowerCase()));
    const enriched: EnrichedOpportunity[] = opportunities.map((o) => {
      const path = normalizePath(extractPathFromUrlOrPath(o.page));
      const e = engagementByPath.get(path);
      const hasTraffic = Boolean(e);
      const avgEngagementSec = e ? e.avgEngagementSec : null;
      const bounceRate = e ? e.bounceRate : null;

      const inTop = topQueriesSet.has(o.query.toLowerCase());
      const bucket = classifyOpportunity({
        impressions: o.impressions,
        position: o.position,
        hasTraffic,
        bounceRate,
        avgEngagementSec,
        appearsInTopQueries: inTop,
      });

      return { ...o, avgEngagementSec, bounceRate, hasTraffic, bucket };
    });

    const byBucket: Record<OpportunityBucket, EnrichedOpportunity[]> = {
      write_new: [],
      fix_meta: [],
      improve_content: [],
      double_down: [],
    };
    for (const e of enriched) byBucket[e.bucket].push(e);

    // Stable, useful ordering: prioritize higher impressions.
    for (const k of Object.keys(byBucket) as OpportunityBucket[]) {
      byBucket[k].sort((a, b) => b.impressions - a.impressions);
    }

    const topAvgEngagement = pageEngagement.length
      ? Math.round(
          [...pageEngagement]
            .sort((a, b) => b.avgEngagementSec - a.avgEngagementSec)
            .slice(0, 10)
            .reduce((sum, r) => sum + r.avgEngagementSec, 0) / Math.min(10, pageEngagement.length)
        )
      : 0;

    const lines: string[] = [...headerLines];

    if (!gscEnabled) {
      lines.push('WARNING: GSC is not configured; brief is GA4-only.');
      lines.push('');
    }
    if (!gaEnabled) {
      lines.push('WARNING: GA4 is not configured or property id missing; brief is GSC-only.');
      lines.push('');
    }

    lines.push('--- WRITE NEW (highest priority) ---');
    lines.push('These queries appear in Google but have no well-targeted page yet.');
    if (byBucket.write_new.length === 0) {
      lines.push('  (none detected yet)');
    } else {
      for (const o of byBucket.write_new.slice(0, 12)) {
        lines.push(`  Query: "${o.query}"`);
        lines.push(`  Impressions: ${o.impressions} | Avg Position: ${o.position.toFixed(1)}`);
        lines.push(`  Target page to create: ${o.page}`);
        lines.push('');
      }
    }

    lines.push('--- FIX META (quick wins) ---');
    lines.push("These pages rank well but don't get clicked. Rewrite title + meta description.");
    if (byBucket.fix_meta.length === 0) {
      lines.push('  (none detected yet)');
    } else {
      for (const o of byBucket.fix_meta.slice(0, 12)) {
        lines.push(`  Query: "${o.query}"`);
        lines.push(`  Current page: ${o.page}`);
        lines.push(`  Impressions: ${o.impressions} | Position: ${o.position.toFixed(1)} | CTR: 0%`);
        lines.push('  Action: Rewrite <title> and meta description targeting this query');
        lines.push('');
      }
    }

    lines.push('--- IMPROVE CONTENT (intent mismatch) ---');
    lines.push("People land on these pages but leave immediately. Content doesn't match intent.");
    if (byBucket.improve_content.length === 0) {
      lines.push('  (none detected yet)');
    } else {
      for (const o of byBucket.improve_content.slice(0, 12)) {
        const br = o.bounceRate == null ? 'n/a' : `${Math.round(o.bounceRate * 100)}%`;
        const eng = o.avgEngagementSec == null ? 'n/a' : `${Math.round(o.avgEngagementSec)}s`;
        lines.push(`  Page: ${o.page}`);
        lines.push(`  Bounce rate: ${br} | Avg engagement: ${eng}`);
        lines.push(`  Query driving traffic: ${o.query}`);
        lines.push('  Action: Rewrite opening section to match search intent more precisely');
        lines.push('');
      }
    }

    lines.push('--- DOUBLE DOWN (working content) ---');
    lines.push('These topics perform well. Write follow-up posts or expand into a cluster.');
    if (byBucket.double_down.length === 0) {
      lines.push('  (none detected yet)');
    } else {
      for (const o of byBucket.double_down.slice(0, 10)) {
        const eng = o.avgEngagementSec == null ? 'n/a' : `${Math.round(o.avgEngagementSec)}s`;
        const clicks = topQueries.find((t) => t.query.toLowerCase() === o.query.toLowerCase())?.clicks ?? 0;
        lines.push(`  Query: "${o.query}" — ${clicks} clicks, ${eng} avg engagement`);
        lines.push('  Suggestion: Write a follow-up targeting a related long-tail variation');
        lines.push('');
      }
    }

    lines.push('--- CONTENT INSTRUCTIONS FOR THIS RUN ---');
    lines.push('1. Pick ONE query from WRITE NEW as your primary target for this post');
    lines.push('2. Use the target keyword naturally in: title, first 100 words, one H2');
    lines.push('3. Write meta title (max 60 chars) and meta description (max 155 chars)');
    if (topAvgEngagement > 0) {
      lines.push(`4. Depth: match or exceed avg engagement of top performers (${topAvgEngagement}s read time)`);
    } else {
      lines.push('4. Depth: make it deep enough that a serious buyer would bookmark it');
    }
    lines.push('5. Tone: authoritative, builder-focused, zero generic agency language');
    lines.push('6. End with a specific CTA relevant to PrimeStrides services');
    lines.push('');

    lines.push("--- WHAT'S WORKING (don't change) ---");
    lines.push('Top performing content by engagement:');
    if (pageEngagement.length === 0) {
      lines.push('  (no GA4 engagement rows yet)');
    } else {
      const top3 = [...pageEngagement].sort((a, b) => b.avgEngagementSec - a.avgEngagementSec).slice(0, 3);
      for (const p of top3) {
        lines.push(`  ${p.page} — ${Math.round(p.avgEngagementSec)}s avg, ${Math.round(p.bounceRate * 100)}% bounce`);
      }
    }

    lines.push('=== END BRIEF ===');
    return lines.join('\n');
  }
}

async function getKeywordOpportunities(
  gsc: NonNullable<ReturnType<typeof buildGscClient>>,
  args: { siteUrl: string; startDate: string; endDate: string }
): Promise<KeywordOpportunity[]> {
  const rows = await gsc.queryPerformance({
    siteUrl: args.siteUrl,
    startDate: args.startDate,
    endDate: args.endDate,
    dimensions: ['query', 'page'],
    rowLimit: 25000,
  });

  return rows
    .filter((r) => r.impressions >= 5 && r.clicks === 0 && r.query && r.page)
    .sort((a, b) => b.impressions - a.impressions)
    .map((r) => ({
      query: r.query,
      page: r.page,
      impressions: Math.round(r.impressions),
      position: Number(r.position) || 0,
    }));
}

async function getTopPerformingQueries(
  gsc: NonNullable<ReturnType<typeof buildGscClient>>,
  args: { siteUrl: string; startDate: string; endDate: string }
): Promise<TopQuery[]> {
  const rows = await gsc.queryPerformance({
    siteUrl: args.siteUrl,
    startDate: args.startDate,
    endDate: args.endDate,
    dimensions: ['query', 'page'],
    rowLimit: 25000,
  });

  return rows
    .filter((r) => r.clicks >= 1 && r.query && r.page)
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10)
    .map((r) => ({
      query: r.query,
      page: r.page,
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Number(r.ctr) || 0,
      position: Number(r.position) || 0,
    }));
}

function classifyOpportunity(args: {
  impressions: number;
  position: number;
  hasTraffic: boolean;
  bounceRate: number | null;
  avgEngagementSec: number | null;
  appearsInTopQueries: boolean;
}): OpportunityBucket {
  // fix_meta — impressions >= 10, position <= 20, clicks === 0
  if (args.impressions >= 10 && args.position > 0 && args.position <= 20) return 'fix_meta';

  // improve_content — hasTraffic true, bounceRate > 0.7, avgEngagementSec < 30
  if (args.hasTraffic && (args.bounceRate ?? 0) > 0.7 && (args.avgEngagementSec ?? 0) < 30) return 'improve_content';

  // double_down — appears in topQueries AND GA4 engagement high
  if (args.appearsInTopQueries && (args.avgEngagementSec ?? 0) > 120) return 'double_down';

  // write_new — impressions >= 5, clicks === 0, hasTraffic false
  if (args.impressions >= 5 && !args.hasTraffic) return 'write_new';

  // Default: keep it actionable and conservative
  return args.hasTraffic ? 'improve_content' : 'write_new';
}

function extractPathFromUrlOrPath(urlOrPath: string): string {
  if (!urlOrPath) return '';
  if (urlOrPath.startsWith('/')) return urlOrPath;
  try {
    const u = new URL(urlOrPath);
    return u.pathname || '/';
  } catch {
    return urlOrPath;
  }
}

function normalizePath(path: string): string {
  const p = (path || '').trim();
  if (!p) return '';
  const withoutQuery = p.split('?')[0] ?? p;
  const withoutHash = withoutQuery.split('#')[0] ?? withoutQuery;
  const ensured = withoutHash.startsWith('/') ? withoutHash : `/${withoutHash}`;
  // Normalize trailing slash (GA4 often omits it)
  return ensured !== '/' ? ensured.replace(/\/+$/, '') : ensured;
}

function getGscDateRange(daysBack: number): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - 1 * 86400000);
  const start = new Date(end.getTime() - daysBack * 86400000);
  return { startDate: toIsoDate(start), endDate: toIsoDate(end) };
}

function toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0]!;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

