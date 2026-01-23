/**
 * Test script to generate a post for a specific website
 * Usage: npx tsx scripts/generate-for-website.ts <domain>
 * Example: npx tsx scripts/generate-for-website.ts primestrides.com
 */

import { mysqlPool } from '../src/db/mysqlPool.js';
import { WebsiteService } from '../src/services/websiteService.js';

async function main() {
  const domain = process.argv[2];
  
  if (!domain) {
    console.log('Usage: npx tsx scripts/generate-for-website.ts <domain>');
    console.log('Example: npx tsx scripts/generate-for-website.ts primestrides.com');
    
    // List available websites
    const websiteService = new WebsiteService(mysqlPool);
    const websites = await websiteService.getActiveWebsites();
    console.log('\nAvailable websites:');
    for (const w of websites) {
      console.log(`  - ${w.domain}`);
    }
    await mysqlPool.end();
    return;
  }

  const websiteService = new WebsiteService(mysqlPool);
  const website = await websiteService.getByDomain(domain);

  if (!website) {
    console.error(`Website not found: ${domain}`);
    await mysqlPool.end();
    process.exit(1);
  }

  console.log('\n🌐 Website Configuration:');
  console.log(`  Name: ${website.name}`);
  console.log(`  Domain: ${website.domain}`);
  console.log(`  Brand: ${website.brandName}`);
  console.log(`  Voice: ${website.voicePerspective}`);
  console.log(`  Tagline: ${website.tagline}`);
  
  console.log('\n📝 Voice Instructions that will be injected:');
  console.log('─'.repeat(60));
  console.log(websiteService.getVoiceInstructions(website));
  console.log('─'.repeat(60));

  await mysqlPool.end();
}

main().catch(console.error);
