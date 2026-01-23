import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  await mysqlPool.query("UPDATE posts SET status = 'draft', rewrite_count = 0 WHERE 1=1");
  console.log('Posts reset to draft');
  await mysqlPool.end();
}

main();
