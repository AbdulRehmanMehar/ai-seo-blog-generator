import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  // Check posts and their website assignments
  const [posts] = await mysqlPool.query(`
    SELECT p.id, p.title, p.website_id, p.status, w.domain
    FROM posts p
    LEFT JOIN websites w ON w.id = p.website_id
    ORDER BY p.created_at DESC
  `);
  
  console.log('\n=== ALL POSTS ===');
  for (const p of posts as any[]) {
    const title = (p.title as string).slice(0, 50);
    const website = p.domain ?? 'NO WEBSITE';
    console.log(`- ${title}... | ${website} | ${p.status}`);
  }

  // Check websites
  const [websites] = await mysqlPool.query('SELECT id, domain FROM websites WHERE is_active = TRUE');
  console.log('\n=== ACTIVE WEBSITES ===');
  for (const w of websites as any[]) {
    console.log(`- ${w.domain} (id: ${w.id})`);
  }

  // Count posts without website
  const [nullCount] = await mysqlPool.query('SELECT COUNT(*) as cnt FROM posts WHERE website_id IS NULL') as any;
  console.log(`\n=== POSTS WITHOUT WEBSITE: ${nullCount[0].cnt} ===`);

  // Check for orphaned topics (topics without posts)
  const [orphanedTopics] = await mysqlPool.query(`
    SELECT t.id, t.topic, w.domain
    FROM topics t
    LEFT JOIN posts p ON p.topic_id = t.id
    LEFT JOIN websites w ON w.id = t.website_id
    WHERE p.id IS NULL
  `) as any;

  if (orphanedTopics.length > 0) {
    console.log(`\n=== ORPHANED TOPICS (${orphanedTopics.length}) ===`);
    for (const t of orphanedTopics) {
      console.log(`- ${(t.topic as string).slice(0, 50)}... | ${t.domain ?? 'NO WEBSITE'}`);
    }
  }

  await mysqlPool.end();
}

main().catch(console.error);
