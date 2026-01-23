import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

function mysqlConfigFromUrl() {
  const url = new URL(env.MYSQL_URL);
  const database = url.pathname.replace(/^\//, '');
  const isTiDbCloud = url.hostname.toLowerCase().includes('tidbcloud.com');

  const enableTls = env.MYSQL_SSL ?? isTiDbCloud;

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: enableTls
      ? {
          rejectUnauthorized: env.MYSQL_SSL_REJECT_UNAUTHORIZED
        }
      : undefined
  };
}

export const mysqlPool = mysql.createPool({
  ...mysqlConfigFromUrl(),
  multipleStatements: true,
  connectionLimit: 10,
  waitForConnections: true,
  enableKeepAlive: true
});
