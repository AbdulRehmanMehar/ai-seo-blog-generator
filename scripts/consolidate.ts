/**
 * CONSOLIDATE near-duplicate posts.
 *
 * DRY-RUN by default: prints each cluster's chosen survivor and the posts that would be
 * merged + redirected into it. Nothing is changed.
 *
 *   npx tsx scripts/consolidate.ts                 # preview only
 *   npx tsx scripts/consolidate.ts --apply         # actually mark merged + set redirects
 *   npx tsx scripts/consolidate.ts --threshold 0.92 --apply
 *
 * Merged posts get status='merged' + redirect_to_slug=<survivor>; the Next.js app 301s
 * them, and they drop out of the sitemap / internal links automatically.
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { ConsolidationService } from '../src/services/consolidationService.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const threshold = Number(arg('--threshold') ?? 0.90);

  console.log(`Consolidation ${apply ? 'APPLY' : 'DRY-RUN'} | cosine threshold ${threshold}\n`);

  const svc = new ConsolidationService({ mysql: mysqlPool, postgres: postgresPool });
  const result = await svc.consolidate({ threshold, dryRun: !apply });

  for (const plan of result.plans) {
    console.log(`\n● Survivor [${plan.survivor.indexState ?? 'unscanned'}]: ${plan.survivor.title.slice(0, 80)}`);
    console.log(`  /blog/${plan.survivor.slug}`);
    console.log(`  ${plan.merged.length} post(s) → redirect here:`);
    for (const m of plan.merged) {
      console.log(`     [${m.indexState ?? 'unscanned'}] /blog/${m.slug}  —  ${m.title.slice(0, 64)}`);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`Clusters: ${result.clusters}`);
  console.log(`Posts ${apply ? 'merged' : 'that would be merged'}: ${result.postsMerged}`);
  console.log(`Survivors kept: ${result.clusters}`);
  if (apply && result.chainsFixed > 0) console.log(`Redirect chains flattened: ${result.chainsFixed}`);
  console.log(apply
    ? '✅ Applied — merged posts now 301-redirect directly to their final survivor (no chains).'
    : '🔍 Dry-run only. Re-run with --apply to execute.');

  await mysqlPool.end();
  await postgresPool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
