/**
 * Create website variants for existing posts
 * 
 * Strategy:
 * 1. Assign existing posts (written in "I" voice) to theabdulrehman.com
 * 2. Create copies for primestrides.com with status "rewrite" 
 *    so PostRewriter regenerates them with "we" voice
 */

import crypto from 'node:crypto';
import { mysqlPool } from '../src/db/mysqlPool.js';
import type { RowDataPacket } from 'mysql2/promise';

interface WebsiteRow extends RowDataPacket {
  id: string;
  domain: string;
}

interface PostRow extends RowDataPacket {
  id: string;
  topic_id: string;
  title: string;
  slug: string;
  primary_keyword: string;
  meta_title: string;
  meta_description: string;
  content_json: string;
  status: string;
}

async function main() {
  // Get websites
  const [websites] = await mysqlPool.query<WebsiteRow[]>(
    `SELECT id, domain FROM websites WHERE is_active = TRUE`
  );
  
  const personalSite = websites.find(w => w.domain === 'theabdulrehman.com');
  const agencySite = websites.find(w => w.domain === 'primestrides.com');
  
  if (!personalSite || !agencySite) {
    console.error('❌ Could not find both websites');
    await mysqlPool.end();
    return;
  }
  
  console.log(`\n📌 Personal site: ${personalSite.domain} (${personalSite.id})`);
  console.log(`📌 Agency site: ${agencySite.domain} (${agencySite.id})`);
  
  // Get all posts without a website assignment
  const [unassignedPosts] = await mysqlPool.query<PostRow[]>(
    `SELECT id, topic_id, title, slug, primary_keyword, meta_title, meta_description, content_json, status
     FROM posts 
     WHERE website_id IS NULL`
  );
  
  if (unassignedPosts.length === 0) {
    console.log('\n✅ No unassigned posts found. All posts already have website variants.');
    await mysqlPool.end();
    return;
  }
  
  console.log(`\n📝 Found ${unassignedPosts.length} unassigned post(s)`);
  
  for (const post of unassignedPosts) {
    console.log(`\n─────────────────────────────────────────────────────`);
    console.log(`📄 Post: "${post.title}"`);
    
    // 1. Assign original post to personal site (it's already in "I" voice)
    await mysqlPool.execute(
      `UPDATE posts SET website_id = ? WHERE id = ?`,
      [personalSite.id, post.id]
    );
    console.log(`   ✅ Assigned to ${personalSite.domain}`);
    
    // 2. Create a copy for the agency site
    const newPostId = crypto.randomUUID();
    const newSlug = `${post.slug}-agency`; // Append -agency to make slug unique
    
    // Ensure content_json is a string
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
        post.title, // Will be rewritten
        newSlug,
        post.primary_keyword,
        post.meta_title,
        post.meta_description,
        contentJsonStr // Content will be rewritten with "we" voice
      ]
    );
    console.log(`   ✅ Created variant for ${agencySite.domain} (status: rewrite)`);
    console.log(`      New post ID: ${newPostId}`);
  }
  
  // Summary
  const [summary] = await mysqlPool.query(`
    SELECT w.domain, COUNT(p.id) as post_count, 
           SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) as published,
           SUM(CASE WHEN p.status = 'rewrite' THEN 1 ELSE 0 END) as pending_rewrite
    FROM websites w
    LEFT JOIN posts p ON p.website_id = w.id
    GROUP BY w.id, w.domain
  `);
  
  console.log('\n═════════════════════════════════════════════════════');
  console.log('📊 Summary by website:');
  for (const row of summary as any[]) {
    console.log(`   ${row.domain}: ${row.post_count} posts (${row.published} published, ${row.pending_rewrite} pending rewrite)`);
  }
  
  console.log('\n💡 Run the pipeline to rewrite agency variants with "we" voice:');
  console.log('   npm run runOnce');
  
  await mysqlPool.end();
}

main().catch(console.error);
