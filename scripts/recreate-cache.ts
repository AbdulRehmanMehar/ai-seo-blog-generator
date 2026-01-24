import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  await mysqlPool.query('DROP TABLE IF EXISTS keyword_seed_cache');
  await mysqlPool.query(`
    CREATE TABLE keyword_seed_cache (
      cache_key VARCHAR(50) PRIMARY KEY,
      seeds TEXT NOT NULL,
      generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('Cache table recreated with TEXT column');
  process.exit(0);
}
main();
