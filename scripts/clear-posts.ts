import { createPool } from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const url = new URL(process.env.MYSQL_URL!);
  const pool = createPool({
    host: url.hostname,
    port: parseInt(url.port || '3306'),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: process.env.MYSQL_SSL_REJECT_UNAUTHORIZED === 'true' } : undefined
  });

  await pool.execute('DELETE FROM post_reviews');
  await pool.execute('DELETE FROM posts');
  console.log('✅ Posts and reviews cleared');
  await pool.end();
}

main().catch(console.error);
