import { runPipelineOnce } from '../src/scheduler/orchestrator.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';

async function main() {
  try {
    await runPipelineOnce();
  } catch (err) {
    console.error('Pipeline failed:', err);
  } finally {
    await mysqlPool.end();
    await postgresPool.end();
  }
}

main();
