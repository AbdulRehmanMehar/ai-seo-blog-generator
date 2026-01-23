import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

function pgConfigFromUrl() {
  const url = new URL(env.POSTGRES_URL);
  const database = url.pathname.replace(/^\//, '');
  const sslMode = url.searchParams.get('sslmode');

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: sslMode
      ? {
          rejectUnauthorized: env.POSTGRES_SSL_REJECT_UNAUTHORIZED
        }
      : undefined
  };
}

export const postgresPool = new Pool({
  ...pgConfigFromUrl()
});
