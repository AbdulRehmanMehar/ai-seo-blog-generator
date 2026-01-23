/**
 * Assign unassigned posts to a default website
 * 
 * Usage:
 *   npx tsx scripts/assign-unassigned-posts.ts [website_domain]
 * 
 * If no domain is provided, defaults to theabdulrehman.com (personal site)
 */

import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  const targetDomain = process.argv[2] || 'theabdulrehman.com';

  // Get target website
  const [websites] = await mysqlPool.query(
    'SELECT id, domain FROM websites WHERE domain = ?',
    [targetDomain]
  ) as any;

  if (websites.length === 0) {
    console.error(`Website not found: ${targetDomain}`);
    process.exit(1);
  }

  const website = websites[0];
  console.log(`\nTarget website: ${website.domain} (id: ${website.id})`);

  // Find unassigned posts
  const [unassigned] = await mysqlPool.query(`
    SELECT id, title, status FROM posts WHERE website_id IS NULL
  `) as any;

  if (unassigned.length === 0) {
    console.log('\n✓ No unassigned posts found');
    await mysqlPool.end();
    return;
  }

  console.log(`\nFound ${unassigned.length} unassigned post(s):`);
  for (const p of unassigned) {
    console.log(`  - ${p.title.slice(0, 60)}... (${p.status})`);
  }

  // Assign posts to website
  const [result] = await mysqlPool.query(
    'UPDATE posts SET website_id = ? WHERE website_id IS NULL',
    [website.id]
  ) as any;

  console.log(`\n✓ Assigned ${result.affectedRows} post(s) to ${website.domain}`);

  // Also update their topics
  const [topicResult] = await mysqlPool.query(`
    UPDATE topics t
    JOIN posts p ON p.topic_id = t.id
    SET t.website_id = ?
    WHERE t.website_id IS NULL AND p.website_id = ?
  `, [website.id, website.id]) as any;

  console.log(`✓ Updated ${topicResult.affectedRows} topic(s)`);

  await mysqlPool.end();
}

main().catch(console.error);
