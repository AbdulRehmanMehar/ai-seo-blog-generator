/**
 * Test the website assignment logic without running the full pipeline
 */

import { mysqlPool } from '../src/db/mysqlPool.js';
import { WebsiteService } from '../src/services/websiteService.js';

async function main() {
  const websiteService = new WebsiteService(mysqlPool);

  console.log('\n=== WEBSITE ASSIGNMENT TEST ===\n');

  // Get all active websites
  const websites = await websiteService.getActiveWebsites();
  console.log('Active websites:');
  for (const w of websites) {
    console.log(`  - ${w.domain} (${w.voicePerspective})`);
  }

  // Count recent posts per website (last 7 days)
  const [rows] = await mysqlPool.query(`
    SELECT w.domain, w.id, COUNT(p.id) as post_count
    FROM websites w
    LEFT JOIN posts p ON p.website_id = w.id 
      AND p.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
    WHERE w.is_active = TRUE
    GROUP BY w.id, w.domain
    ORDER BY post_count ASC
  `) as any;

  console.log('\nPosts in last 7 days:');
  for (const r of rows) {
    console.log(`  - ${r.domain}: ${r.post_count} post(s)`);
  }

  // Determine which would be selected
  let minCount = Infinity;
  let selected = rows[0];
  for (const r of rows) {
    if (r.post_count < minCount) {
      minCount = r.post_count;
      selected = r;
    }
  }

  console.log(`\n🎯 NEXT TARGET: ${selected.domain}`);
  console.log(`   (has fewest posts: ${selected.post_count})`);

  // Show voice config for that website
  const website = await websiteService.getById(selected.id);
  if (website) {
    console.log(`\n📝 Voice Configuration:`);
    console.log(`   Perspective: ${website.voicePerspective}`);
    console.log(`   Brand: ${website.brandName}`);
    console.log(`   CTA URL: ${website.defaultCtaUrl}`);
    
    const voice = websiteService.getVoiceInstructions(website);
    console.log(`\n📣 Voice Instructions (preview):`);
    console.log(voice.split('\n').map(l => `   ${l}`).join('\n'));
  }

  await mysqlPool.end();
}

main().catch(console.error);
