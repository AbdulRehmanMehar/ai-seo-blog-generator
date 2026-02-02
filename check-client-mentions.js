import mysql from 'mysql2/promise';

async function checkPosts() {
  const pool = mysql.createPool({
    uri: 'mysql://g1UK7SLKJj2K3Ph.root:tFXOt30PRF6osrUQ@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/main',
    ssl: { rejectUnauthorized: true }
  });

  try {
    const [posts] = await pool.query(`
      SELECT id, title, content_json, created_at
      FROM posts
      WHERE JSON_SEARCH(content_json, 'one', '%helped%') IS NOT NULL
         OR JSON_SEARCH(content_json, 'one', '%client%') IS NOT NULL
         OR JSON_SEARCH(content_json, 'one', '%customer%') IS NOT NULL
         OR JSON_SEARCH(content_json, 'one', '%worked with%') IS NOT NULL
         OR JSON_SEARCH(content_json, 'one', '%case study%') IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10
    `);

    console.log('\n=== Posts with potential client mentions ===\n');
    console.log('Total found:', posts.length);
    console.log('\n');
    
    posts.forEach((post, idx) => {
      console.log(`\n--- Post #${idx + 1} ---`);
      console.log('ID:', post.id);
      console.log('Title:', post.title);
      console.log('Created:', post.created_at);
      
      // Extract relevant mentions from JSON
      const contentJson = typeof post.content_json === 'string' 
        ? JSON.parse(post.content_json) 
        : post.content_json;
      
      const contentStr = JSON.stringify(contentJson, null, 2);
      const lines = contentStr.split('\n');
      console.log('\nMentions of clients/customers/helped:');
      
      lines.forEach((line, lineIdx) => {
        const lowerLine = line.toLowerCase();
        if (lowerLine.includes('helped') || 
            lowerLine.includes('client') || 
            lowerLine.includes('customer') || 
            lowerLine.includes('worked with') ||
            lowerLine.includes('case study')) {
          console.log(`  Line ${lineIdx + 1}: ${line.trim()}`);
        }
      });
      
      console.log('\n' + '='.repeat(100));
    });
  } finally {
    await pool.end();
  }
}

checkPosts().catch(console.error);
