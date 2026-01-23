import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';

async function main() {
  console.log('🗑️  Cleaning up existing posts and related data...\n');

  // Delete in correct order due to foreign keys
  console.log('Deleting post_reviews...');
  const [r1] = await mysqlPool.query('DELETE FROM post_reviews');
  console.log(`   Deleted ${(r1 as any).affectedRows} reviews`);

  console.log('Deleting learning_sources...');
  const [r2] = await mysqlPool.query('DELETE FROM learning_sources');
  console.log(`   Deleted ${(r2 as any).affectedRows} learning sources`);

  console.log('Deleting posts...');
  const [r3] = await mysqlPool.query('DELETE FROM posts');
  console.log(`   Deleted ${(r3 as any).affectedRows} posts`);

  console.log('Deleting topics...');
  const [r4] = await mysqlPool.query('DELETE FROM topics');
  console.log(`   Deleted ${(r4 as any).affectedRows} topics`);

  console.log('Deleting embeddings from Postgres...');
  const r5 = await postgresPool.query('DELETE FROM embeddings');
  console.log(`   Deleted ${r5.rowCount} embeddings`);

  // Keep keywords and learnings - we want the learnings to persist!
  console.log('\n✅ Cleanup complete!');
  console.log('   Note: Keywords and prompt_learnings preserved for new generation');

  // Show remaining learnings
  const [learnings] = await mysqlPool.query('SELECT COUNT(*) as count FROM prompt_learnings');
  console.log(`   Prompt learnings retained: ${(learnings as any)[0].count} rules`);

  await mysqlPool.end();
  await postgresPool.end();
}

main().catch(console.error);
