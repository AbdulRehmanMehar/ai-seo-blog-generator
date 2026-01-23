import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresPool } from './postgresPool.js';
import { mysqlPool } from './mysqlPool.js';
import type { RowDataPacket } from 'mysql2/promise';

type MigrationEngine = 'postgres' | 'mysql';

async function ensureMigrationsTable(engine: MigrationEngine) {
  if (engine === 'postgres') {
    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations_pg (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    return;
  }

  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations_mysql (
      id VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedIds(engine: MigrationEngine): Promise<Set<string>> {
  if (engine === 'postgres') {
    const res = await postgresPool.query<{ id: string }>('SELECT id FROM schema_migrations_pg');
    return new Set(res.rows.map((r) => r.id));
  }

  const [rows] = await mysqlPool.query<RowDataPacket[]>('SELECT id FROM schema_migrations_mysql');
  return new Set(rows.map((r) => String((r as any).id)));
}

async function applyMigration(engine: MigrationEngine, id: string, sql: string) {
  if (engine === 'postgres') {
    await postgresPool.query('BEGIN');
    try {
      await postgresPool.query(sql);
      await postgresPool.query('INSERT INTO schema_migrations_pg(id) VALUES ($1)', [id]);
      await postgresPool.query('COMMIT');
      // eslint-disable-next-line no-console
      console.log(`Applied postgres migration ${id}`);
    } catch (e) {
      await postgresPool.query('ROLLBACK');
      throw e;
    }
    return;
  }

  const conn = await mysqlPool.getConnection();
  try {
    await conn.beginTransaction();
    // MySQL driver doesn't reliably support multi-statement unless enabled on the connection.
    // Execute statements naively by splitting on ';' (good enough for our simple migrations).
    for (const stmt of sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      await conn.query(stmt);
    }
    await conn.query('INSERT INTO schema_migrations_mysql(id) VALUES (?)', [id]);
    await conn.commit();
    // eslint-disable-next-line no-console
    console.log(`Applied mysql migration ${id}`);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
async function runMigrations(engine: MigrationEngine) {
  await ensureMigrationsTable(engine);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationsDir = path.resolve(__dirname, `../../migrations/${engine}`);

  const files = (await fs.readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = await getAppliedIds(engine);

  for (const file of files) {
    const id = file;
    if (applied.has(id)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await applyMigration(engine, id, sql);
  }
}

async function main() {
  await runMigrations('postgres');
  await runMigrations('mysql');

  await postgresPool.end();
  await mysqlPool.end();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  await postgresPool.end();
  await mysqlPool.end();
  process.exit(1);
});
