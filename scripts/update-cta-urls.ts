import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  await mysqlPool.execute(
    `UPDATE websites SET default_cta_url = 'https://www.primestrides.com/#contact' WHERE domain = 'primestrides.com'`
  );
  await mysqlPool.execute(
    `UPDATE websites SET default_cta_url = 'https://www.theabdulrehman.com/#contact' WHERE domain = 'theabdulrehman.com'`
  );

  const [rows] = await mysqlPool.query('SELECT domain, default_cta_url FROM websites');
  console.log('✅ Updated CTA URLs:');
  for (const r of rows as any[]) {
    console.log(`  ${r.domain} → ${r.default_cta_url}`);
  }

  await mysqlPool.end();
}

main();
