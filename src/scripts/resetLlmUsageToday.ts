import { mysqlPool } from '../db/mysqlPool.js';

async function main() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const [result] = await mysqlPool.query(`DELETE FROM llm_usage_daily WHERE day = ?`, [todayUtc]);
  // eslint-disable-next-line no-console
  console.log(`Reset llm_usage_daily for day=${todayUtc} (${(result as any)?.affectedRows ?? 0} rows)`);
  await mysqlPool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
