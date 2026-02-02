import mysql from 'mysql2/promise';

async function flagFabricatedPosts() {
  const pool = mysql.createPool({
    uri: 'mysql://g1UK7SLKJj2K3Ph.root:tFXOt30PRF6osrUQ@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/main',
    ssl: { rejectUnauthorized: true }
  });

  try {
    // Fabrication patterns to check
    const fabricationPatterns = [
      "my client",
      "my clients",
      "i helped a",
      "i helped client",
      "helped company",
      "worked with a startup",
      "worked with 3",
      "series a startup",
      "helped them",
      "this saved them",
      "save clients",
      "client saw",
      "customer saw",
    ];

    console.log('\n=== Scanning for Fabricated Client Stories ===\n');

    const [allPosts] = await pool.query(`
      SELECT id, title, content_json, status, created_at
      FROM posts
      WHERE status IN ('draft', 'published')
      ORDER BY created_at DESC
    `);

    const flaggedPosts = [];

    allPosts.forEach(post => {
      const contentJson = typeof post.content_json === 'string' 
        ? JSON.parse(post.content_json) 
        : post.content_json;

      const contentStr = JSON.stringify(contentJson).toLowerCase();
      const matches = [];

      fabricationPatterns.forEach(pattern => {
        if (contentStr.includes(pattern)) {
          matches.push(pattern);
        }
      });

      if (matches.length > 0) {
        flaggedPosts.push({
          id: post.id,
          title: post.title,
          status: post.status,
          created_at: post.created_at,
          matches,
          content: contentJson
        });
      }
    });

    console.log(`Total posts scanned: ${allPosts.length}`);
    console.log(`Posts with potential fabrications: ${flaggedPosts.length}\n`);

    if (flaggedPosts.length === 0) {
      console.log('✅ No fabricated client stories found!');
      return;
    }

    console.log('⚠️  Posts flagged for review:\n');

    flaggedPosts.forEach((post, idx) => {
      console.log(`${idx + 1}. "${post.title}"`);
      console.log(`   ID: ${post.id}`);
      console.log(`   Status: ${post.status}`);
      console.log(`   Created: ${post.created_at}`);
      console.log(`   Matched patterns: ${post.matches.join(', ')}`);
      
      // Show the problematic sentences
      post.content.sections?.forEach((section, sIdx) => {
        const content = section.content || '';
        const lowerContent = content.toLowerCase();
        
        post.matches.forEach(pattern => {
          if (lowerContent.includes(pattern)) {
            const sentences = content.split(/[.!?]+/).filter(s => s.trim());
            sentences.forEach(sentence => {
              if (sentence.toLowerCase().includes(pattern)) {
                console.log(`   📍 Section ${sIdx + 1}: "${sentence.trim()}..."`);
              }
            });
          }
        });
      });
      
      console.log('');
    });

    // Provide SQL to mark these for rewrite
    console.log('\n=== Recommended Action ===\n');
    console.log('To mark these posts for rewrite, run:\n');
    const ids = flaggedPosts.map(p => `'${p.id}'`).join(', ');
    console.log(`UPDATE posts SET status = 'rewrite' WHERE id IN (${ids});\n`);

  } finally {
    await pool.end();
  }
}

flagFabricatedPosts().catch(console.error);
