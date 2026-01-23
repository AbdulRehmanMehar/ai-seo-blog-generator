import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  const [websites] = await mysqlPool.query(`SELECT id, name, domain, voice_perspective, brand_name FROM websites`);
  console.log('\n📌 Websites configured:');
  for (const w of websites as any[]) {
    console.log(`  - ${w.name} (${w.domain})`);
    console.log(`    Voice: ${w.voice_perspective}, Brand: ${w.brand_name}`);
    console.log(`    ID: ${w.id}`);
  }

  const [posts] = await mysqlPool.query(`
    SELECT p.title, p.status, w.domain 
    FROM posts p 
    LEFT JOIN websites w ON w.id = p.website_id 
    ORDER BY p.created_at DESC 
    LIMIT 5
  `);
  console.log('\n📝 Recent posts:');
  for (const p of posts as any[]) {
    console.log(`  - ${p.title}`);
    console.log(`    Status: ${p.status}, Website: ${p.domain || 'not assigned'}`);
  }

  await mysqlPool.end();
}
main();
