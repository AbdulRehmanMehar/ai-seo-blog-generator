import mysql from 'mysql2/promise';
import { topicPlanningPrompt } from '../src/prompts/topicPlanning.js';
import { loadAuthorKnowledge } from '../src/knowledge/authorKnowledge.js';
import { env } from '../src/config/env.js';

async function dryRun() {
  const pool = await mysql.createPool({
    uri: env.MYSQL_URL,
    ssl: { rejectUnauthorized: true }
  });

  const knowledge = await loadAuthorKnowledge();
  
  // Get websites
  const [websites] = await pool.query('SELECT id, domain FROM websites WHERE is_active = 1');
  
  for (const website of websites as any[]) {
    console.log('\n' + '='.repeat(70));
    console.log('🌐 Website:', website.domain);
    console.log('='.repeat(70));
    
    // Get existing posts for this website
    const [posts] = await pool.query(
      'SELECT title, primary_keyword FROM posts WHERE website_id = ? ORDER BY created_at DESC LIMIT 50',
      [website.id]
    );
    
    const existingPosts = (posts as any[]).map(p => ({
      title: p.title,
      keyword: p.primary_keyword
    }));
    
    console.log('\n📚 Existing posts (' + existingPosts.length + '):');
    existingPosts.forEach(p => console.log('  - "' + p.title + '" [' + p.keyword + ']'));
    
    // Get sample keywords
    const [keywords] = await pool.query(
      "SELECT keyword, volume, cpc, intent FROM keywords WHERE status = 'new' LIMIT 5"
    );
    
    console.log('\n🔑 Sample new keywords:');
    (keywords as any[]).forEach(k => console.log('  -', k.keyword));
    
    // Generate the prompt
    const prompt = topicPlanningPrompt({
      knowledge,
      candidateKeywords: (keywords as any[]).map(k => ({
        keyword: k.keyword,
        volume: k.volume,
        difficulty: null,
        cpc: parseFloat(k.cpc),
        intent: k.intent
      })),
      selectCount: 2,
      targetWebsite: website.domain,
      existingPosts: existingPosts.length > 0 ? existingPosts : undefined
    });
    
    // Show the prompt section about existing posts
    console.log('\n📝 PROMPT EXCERPT (what AI sees about existing posts):');
    console.log('-'.repeat(70));
    const existingSection = prompt.user.match(/⚠️ EXISTING CONTENT[\s\S]*?EXAMPLES OF GOOD DIFFERENTIATION:[\s\S]*?\n/);
    if (existingSection) {
      console.log(existingSection[0]);
    } else {
      console.log('  (No existing posts section - this is a fresh website)');
    }
    console.log('-'.repeat(70));
  }
  
  await pool.end();
  console.log('\n✅ Dry run complete!');
}

dryRun().catch(console.error);
