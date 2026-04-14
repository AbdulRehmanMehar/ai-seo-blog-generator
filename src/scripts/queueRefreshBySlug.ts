import crypto from 'node:crypto';
import { mysqlPool } from '../db/mysqlPool.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { WebsiteService } from '../services/websiteService.js';

type RefreshType = 'full_refresh' | 'ctr_optimize' | 'section_expand';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usageAndExit(): never {
  // eslint-disable-next-line no-console
  console.log(`
Queue a manual content rewrite by slug.

Usage:
  npx tsx src/scripts/queueRefreshBySlug.ts --slug <slug> [--domain <domain>|--websiteId <id>] [--type full_refresh|ctr_optimize|section_expand]

Examples:
  npx tsx src/scripts/queueRefreshBySlug.ts --slug luxury-digital-transformation-erodes-brand-value --domain primestrides.com
  npx tsx src/scripts/queueRefreshBySlug.ts --slug my-post --domain theabdulrehman.com --type ctr_optimize
`);
  process.exit(1);
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) usageAndExit();

  const slug = (getArg('--slug') ?? '').trim();
  if (!slug) usageAndExit();

  const refreshType = ((getArg('--type') ?? 'full_refresh').trim() as RefreshType) || 'full_refresh';
  if (!['full_refresh', 'ctr_optimize', 'section_expand'].includes(refreshType)) {
    throw new Error(`Invalid --type "${refreshType}"`);
  }

  const domain = getArg('--domain')?.trim();
  const websiteIdArg = getArg('--websiteId')?.trim();

  const websiteService = new WebsiteService(mysqlPool);

  let websiteId: string | null = null;
  if (websiteIdArg) {
    websiteId = websiteIdArg;
  } else if (domain) {
    const w = await websiteService.getByDomain(domain);
    if (!w) throw new Error(`Website not found for domain "${domain}"`);
    websiteId = w.id;
  }

  // Find post by slug (+ optionally website_id)
  const params: any[] = [slug];
  let sql = `SELECT id, website_id FROM posts WHERE slug = ?`;
  if (websiteId) {
    sql += ` AND website_id = ?`;
    params.push(websiteId);
  }
  sql += ` LIMIT 2`;

  const [rows] = await mysqlPool.query<RowDataPacket[]>(sql, params);
  if (rows.length === 0) {
    throw new Error(`No post found for slug "${slug}"${websiteId ? ` on website_id "${websiteId}"` : ''}`);
  }
  if (rows.length > 1) {
    throw new Error(
      `Multiple posts found for slug "${slug}". Re-run with --domain or --websiteId to disambiguate.`
    );
  }

  const postId = String((rows[0] as any).id);
  const postWebsiteId = String((rows[0] as any).website_id ?? '');
  const effectiveWebsiteId = websiteId ?? postWebsiteId;
  if (!effectiveWebsiteId) throw new Error('Post has no website_id and none was provided');

  // Don't double-queue
  const [existing] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id FROM content_refresh_queue WHERE post_id = ? AND status IN ('queued', 'processing') LIMIT 1`,
    [postId]
  );
  if (existing.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`Already queued: post_id=${postId} (slug=${slug})`);
    return;
  }

  const id = crypto.randomUUID();
  await mysqlPool.query<ResultSetHeader>(
    `INSERT INTO content_refresh_queue
       (id, post_id, website_id, refresh_type, trigger_type)
     VALUES (?, ?, ?, ?, 'manual')`,
    [id, postId, effectiveWebsiteId, refreshType]
  );

  // eslint-disable-next-line no-console
  console.log(`Queued refresh: id=${id} post_id=${postId} slug=${slug} website_id=${effectiveWebsiteId} type=${refreshType}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mysqlPool.end();
  });

