import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  await mysqlPool.query('DELETE FROM keyword_seed_cache');
  console.log('Cache cleared');
  process.exit(0);
}
main();
