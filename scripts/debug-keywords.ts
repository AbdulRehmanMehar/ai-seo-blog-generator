import mysql from 'mysql2/promise';
import { env } from '../src/config/env.js';

async function check() {
  const pool = await mysql.createPool({
    uri: env.MYSQL_URL,
    ssl: { rejectUnauthorized: true }
  });
  
  console.log('=== KEYWORD STATUS DISTRIBUTION ===');
  const [statusRows] = await pool.query('SELECT status, COUNT(*) as count FROM keywords GROUP BY status');
  console.table(statusRows);
  
  const [total] = await pool.query('SELECT COUNT(*) as total FROM keywords');
  console.log('Total keywords:', (total as any)[0].total);
  
  console.log('\n=== SAMPLE NEW KEYWORDS ===');
  const [newKeywords] = await pool.query("SELECT keyword, volume, cpc, intent FROM keywords WHERE status = 'new' LIMIT 10");
  console.table(newKeywords);
  
  console.log('\n=== SAMPLE USED KEYWORDS ===');
  const [usedKeywords] = await pool.query("SELECT keyword, status FROM keywords WHERE status = 'used' LIMIT 10");
  console.table(usedKeywords);
  
  console.log('\n=== POST COUNT ===');
  const [posts] = await pool.query('SELECT COUNT(*) as count FROM posts');
  console.table(posts);
  
  console.log('\n=== ACTIVE WEBSITES ===');
  const [websites] = await pool.query("SELECT id, domain, is_active FROM websites WHERE is_active = 1");
  console.table(websites);
  
  await pool.end();
}

check().catch(console.error);
