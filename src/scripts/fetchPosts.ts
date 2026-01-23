import { mysqlPool } from '../db/mysqlPool.js';

async function fetchPosts() {
  const [rows] = await mysqlPool.query(
    `SELECT id, slug, title, meta_title, meta_description, content_json, status, created_at 
     FROM posts 
     ORDER BY created_at DESC 
     LIMIT 2`
  );
  
  for (const row of rows as any[]) {
    console.log('\n' + '='.repeat(80));
    console.log('POST:', row.slug);
    console.log('='.repeat(80));
    console.log('Title:', row.title);
    console.log('Meta Title:', row.meta_title);
    console.log('Meta Description:', row.meta_description);
    console.log('Status:', row.status);
    console.log('Created:', row.created_at);
    console.log('\n--- CONTENT JSON ---\n');
    
    if (row.content_json) {
      const content = typeof row.content_json === 'string' 
        ? JSON.parse(row.content_json) 
        : row.content_json;
      console.log(JSON.stringify(content, null, 2));
    } else {
      console.log('(no content_json)');
    }
  }
  
  await mysqlPool.end();
}

fetchPosts().catch(console.error);
