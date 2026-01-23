import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  // Get latest post and review
  const [posts] = await mysqlPool.query(`
    SELECT p.id, p.title, p.status, p.rewrite_count, pr.score, pr.issues_json, pr.rewrite_instructions
    FROM posts p
    LEFT JOIN post_reviews pr ON pr.post_id = p.id
    ORDER BY p.created_at DESC, pr.reviewed_at DESC
    LIMIT 3
  `);
  
  for (const row of posts as any[]) {
    console.log('\n' + '='.repeat(60));
    console.log('Post:', row.title);
    console.log('Score:', row.score, '| Status:', row.status);
    console.log('\nIssues:');
    const issues = typeof row.issues_json === 'string' ? JSON.parse(row.issues_json) : row.issues_json;
    if (issues) {
      for (const i of issues) {
        console.log('  -', i.code + ':', i.message?.slice(0, 100));
      }
    }
  }
  
  await mysqlPool.end();
}
main();
