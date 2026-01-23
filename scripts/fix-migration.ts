import { mysqlPool } from '../src/db/mysqlPool.js';

async function main() {
  console.log('Fixing posts with null content_json...');
  
  // Delete posts with no content (they'll be regenerated)
  const [result] = await mysqlPool.query(
    'DELETE FROM posts WHERE content_json IS NULL'
  );
  console.log('Deleted posts:', (result as any).affectedRows);

  // Now alter the column to NOT NULL
  await mysqlPool.query('ALTER TABLE posts MODIFY COLUMN content_json JSON NOT NULL');
  console.log('Made content_json NOT NULL');

  // Mark migration as complete
  await mysqlPool.query(
    "INSERT IGNORE INTO schema_migrations_mysql(id) VALUES ('003_structured_content.sql')"
  );
  console.log('Migration marked as complete');

  await mysqlPool.end();
}

main().catch(console.error);
