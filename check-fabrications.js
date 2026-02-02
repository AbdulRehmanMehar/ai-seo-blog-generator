import mysql from 'mysql2/promise';

async function checkFabricatedStories() {
  const pool = mysql.createPool({
    uri: 'mysql://g1UK7SLKJj2K3Ph.root:tFXOt30PRF6osrUQ@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/main',
    ssl: { rejectUnauthorized: true }
  });

  try {
    // Check for various patterns that might indicate fabricated stories
    const patterns = [
      { name: 'Client mentions', pattern: '%client%' },
      { name: 'Customer stories', pattern: '%customer%' },
      { name: 'Case studies', pattern: '%case study%' },
      { name: 'Worked with mentions', pattern: '%worked with%' },
      { name: 'Helped company', pattern: '%helped%company%' },
      { name: 'Startup mentions', pattern: '%startup%increased%' },
      { name: 'Revenue stories', pattern: '%increased revenue%' },
      { name: 'Success stories', pattern: '%success story%' },
      { name: 'Company names pattern', pattern: '%Company%saw%' },
      { name: 'Results claims', pattern: '%resulted in%' },
    ];

    console.log('\n=== Checking for Fabricated Story Patterns ===\n');

    for (const { name, pattern } of patterns) {
      const [posts] = await pool.query(`
        SELECT id, title, status, created_at
        FROM posts
        WHERE JSON_SEARCH(content_json, 'one', ?) IS NOT NULL
        LIMIT 5
      `, [pattern]);

      if (posts.length > 0) {
        console.log(`\n${name}: Found ${posts.length} posts`);
        posts.forEach(post => {
          console.log(`  - "${post.title}" (${post.status}, ${post.created_at})`);
        });
      }
    }

    // Get sample of recent posts to review
    console.log('\n\n=== Recent Posts Sample ===\n');
    const [recentPosts] = await pool.query(`
      SELECT id, title, content_json, status, created_at
      FROM posts
      ORDER BY created_at DESC
      LIMIT 5
    `);

    recentPosts.forEach((post, idx) => {
      console.log(`\n--- Post #${idx + 1}: ${post.title} ---`);
      console.log(`Status: ${post.status}, Created: ${post.created_at}`);
      
      const contentJson = typeof post.content_json === 'string' 
        ? JSON.parse(post.content_json) 
        : post.content_json;
      
      // Show first few sections
      console.log('\nHero hook:', contentJson.hero?.hook || 'N/A');
      console.log('\nFirst 3 sections:');
      (contentJson.sections || []).slice(0, 3).forEach((section, i) => {
        console.log(`\n  Section ${i + 1}: ${section.heading}`);
        console.log(`  ${section.content?.substring(0, 200)}...`);
      });
      console.log('\n' + '='.repeat(100));
    });

  } finally {
    await pool.end();
  }
}

checkFabricatedStories().catch(console.error);
