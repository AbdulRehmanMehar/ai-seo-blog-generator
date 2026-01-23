/**
 * Create agency variants for posts that don't have one yet
 */

import crypto from 'node:crypto';
import { mysqlPool } from '../src/db/mysqlPool.js';
import type { RowDataPacket } from 'mysql2/promise';

async function main() {
  // Get websites
  const [websites] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, domain FROM websites WHERE is_active = TRUE`
  );
  
  const personalSite = websites.find((w: any) => w.domain === 'theabdulrehman.com');
  const agencySite = websites.find((w: any) => w.domain === 'primestrides.com');
  
  if (!personalSite || !agencySite) {
    console.error('❌ Could not find both websites');
    await mysqlPool.end();
    return;
  }
  
  // Get posts on personal site that don't have an agency variant
  const [personalPosts] = await mysqlPool.query<RowDataPacket[]>(`
    SELECT p.* 
    FROM posts p
    WHERE p.website_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM posts p2 
      WHERE p2.website_id = ? 
      AND p2.topic_id = p.topic_id
    )
  `, [personalSite.id, agencySite.id]);
  
  if (personalPosts.length === 0) {
    console.log('✅ All posts already have agency variants');
    
    // Show current state
    const [summary] = await mysqlPool.query(`
      SELECT w.domain, p.title, p.status
      FROM posts p
      JOIN websites w ON w.id = p.website_id
      ORDER BY p.topic_id, w.domain
    `);
    console.log('\n📝 Current posts by website:');
    for (const row of summary as any[]) {
      console.log(`  [${row.domain}] ${row.title} (${row.status})`);
    }
    
    await mysqlPool.end();
    return;
  }
  
  console.log(`\n📝 Creating ${personalPosts.length} agency variant(s)...\n`);
  
  for (const post of personalPosts as any[]) {
    const newPostId = crypto.randomUUID();
    const newSlug = `${post.slug}-agency`;
    
    const contentJsonStr = typeof post.content_json === 'string' 
      ? post.content_json 
      : JSON.stringify(post.content_json);
    
    await mysqlPool.execute(
      `INSERT INTO posts (
        id, website_id, topic_id, title, slug, primary_keyword, 
        meta_title, meta_description, content_json, status, rewrite_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rewrite', 0)`,
      [
        newPostId,
        agencySite.id,
        post.topic_id,
        post.title,
        newSlug,
        post.primary_keyword,
        post.meta_title,
        post.meta_description,
        contentJsonStr
      ]
    );
    console.log(`✅ Created agency variant: "${post.title}"`);
  }
  
  // Final summary
  const [finalSummary] = await mysqlPool.query(`
    SELECT w.domain, COUNT(*) as total,
           SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) as published,
           SUM(CASE WHEN p.status = 'rewrite' THEN 1 ELSE 0 END) as pending
    FROM posts p
    JOIN websites w ON w.id = p.website_id
    GROUP BY w.domain
  `);
  
  console.log('\n📊 Summary:');
  for (const row of finalSummary as any[]) {
    console.log(`  ${row.domain}: ${row.total} posts (${row.published} published, ${row.pending} pending rewrite)`);
  }
  
  console.log('\n💡 Run the pipeline to rewrite agency posts with "we" voice:');
  console.log('   npm run runOnce');
  
  await mysqlPool.end();
}

main().catch(console.error);
