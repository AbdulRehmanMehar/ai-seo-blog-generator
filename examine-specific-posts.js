import mysql from 'mysql2/promise';

async function examinePost() {
  const pool = mysql.createPool({
    uri: 'mysql://g1UK7SLKJj2K3Ph.root:tFXOt30PRF6osrUQ@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/main',
    ssl: { rejectUnauthorized: true }
  });

  try {
    // Get posts with client mentions
    const [posts] = await pool.query(`
      SELECT id, title, content_json
      FROM posts
      WHERE JSON_SEARCH(content_json, 'one', '%client%') IS NOT NULL
         OR JSON_SEARCH(content_json, 'one', '%worked with%') IS NOT NULL
      LIMIT 3
    `);

    posts.forEach((post, idx) => {
      const contentJson = typeof post.content_json === 'string' 
        ? JSON.parse(post.content_json) 
        : post.content_json;

      console.log(`\n${'='.repeat(100)}`);
      console.log(`POST #${idx + 1}: ${post.title}`);
      console.log(`${'='.repeat(100)}\n`);

      // Check all sections for client mentions
      contentJson.sections?.forEach((section, sectionIdx) => {
        const content = section.content || '';
        const lowerContent = content.toLowerCase();
        
        if (lowerContent.includes('client') || 
            lowerContent.includes('worked with') ||
            lowerContent.includes('helped') ||
            lowerContent.includes('customer')) {
          
          console.log(`\n--- Section ${sectionIdx + 1}: ${section.heading} ---`);
          console.log(content);
          
          // Highlight specific sentences
          const sentences = content.split(/[.!?]+/).filter(s => s.trim());
          sentences.forEach(sentence => {
            const lowerSent = sentence.toLowerCase();
            if (lowerSent.includes('client') || 
                lowerSent.includes('worked with') ||
                lowerSent.includes('helped') ||
                lowerSent.includes('customer')) {
              console.log(`\n>>> FLAGGED: ${sentence.trim()}`);
            }
          });
        }
      });
    });

  } finally {
    await pool.end();
  }
}

examinePost().catch(console.error);
