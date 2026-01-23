import { env } from './config/env.js';
import { mysqlPool } from './db/mysqlPool.js';
import { postgresPool } from './db/postgresPool.js';
import { MysqlSerpUsageStore, hashApiKey } from './services/serpUsageStore.js';

function splitCommaList(value?: string): string[] {
  if (!value) return [];
  const trimmed = value.trim().replace(/^"|"$/g, '');
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function checkMysql() {
  await mysqlPool.query('SELECT 1');
  const [tables] = await mysqlPool.query<any[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`
  );
  const set = new Set((tables ?? []).map((r: any) => String(r.table_name)));
  const expected = ['keywords', 'topics', 'posts', 'llm_usage_daily', 'serp_usage_monthly', 'schema_migrations_mysql'];
  const missing = expected.filter((t) => !set.has(t));
  return { ok: true, missing };
}

async function checkPostgres() {
  await postgresPool.query('SELECT 1');
  const res = await postgresPool.query<{ table_name: string }>(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    `
  );
  const set = new Set(res.rows.map((r) => r.table_name));
  const expected = ['embeddings', 'schema_migrations_pg'];
  const missing = expected.filter((t) => !set.has(t));
  return { ok: true, missing };
}

async function testSerpstack() {
  const keys = splitCommaList(env.SERPSTACK_APIS);
  if (keys.length === 0) return { skipped: true, reason: 'SERPSTACK_APIS not set' };

  const store = new MysqlSerpUsageStore(mysqlPool);
  const picked = await store.pickLeastUsedKey({ provider: 'serpstack', apiKeys: keys, perKeyMonthlyLimit: env.SERPSTACK_MAX_LIMIT });
  if (!picked) return { ok: false, error: 'No available Serpstack keys (cap reached?)' };

  const url = new URL('https://api.serpstack.com/search');
  url.searchParams.set('access_key', picked.apiKey);
  url.searchParams.set('query', 'software development consulting');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('num', '3');
  url.searchParams.set('gl', 'us');
  url.searchParams.set('hl', 'en');

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  await store.increment('serpstack', picked.apiKeyHash);

  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, bodySnippet: text.slice(0, 200) };

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Non-JSON response', bodySnippet: text.slice(0, 200) };
  }

  if (json?.success === false) {
    return { ok: false, error: 'API returned success=false', details: json?.error ?? null };
  }

  const relatedSearches = Array.isArray(json?.related_searches) ? json.related_searches.length : 0;
  const relatedQuestions = Array.isArray(json?.related_questions) ? json.related_questions.length : 0;
  const organic = Array.isArray(json?.organic_results) ? json.organic_results.length : 0;

  return {
    ok: true,
    keyHashPrefix: picked.apiKeyHash.slice(0, 8),
    counts: { relatedSearches, relatedQuestions, organic }
  };
}

async function testZenserp() {
  const keys = splitCommaList(env.ZENSERP_APIS);
  if (keys.length === 0) return { skipped: true, reason: 'ZENSERP_APIS not set' };

  const store = new MysqlSerpUsageStore(mysqlPool);
  const picked = await store.pickLeastUsedKey({ provider: 'zenserp', apiKeys: keys, perKeyMonthlyLimit: env.ZENSERP_MAX_LIMIT });
  if (!picked) return { ok: false, error: 'No available Zenserp keys (cap reached?)' };

  const url = new URL('https://app.zenserp.com/api/v2/search');
  url.searchParams.set('q', 'cto consulting');
  url.searchParams.set('num', '3');
  url.searchParams.set('gl', 'us');
  url.searchParams.set('hl', 'en');

  const res = await fetch(url, {
    headers: { apikey: picked.apiKey },
    signal: AbortSignal.timeout(30_000)
  });
  await store.increment('zenserp', picked.apiKeyHash);

  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, bodySnippet: text.slice(0, 200) };

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Non-JSON response', bodySnippet: text.slice(0, 200) };
  }

  const organic = Array.isArray(json?.organic) ? json.organic.length : 0;
  const paid = Array.isArray(json?.paid_results) ? json.paid_results.length : 0;
  const related = Array.isArray(json?.related_searches) ? json.related_searches.length : 0;

  return {
    ok: true,
    keyHashPrefix: picked.apiKeyHash.slice(0, 8),
    counts: { organic, paid, related }
  };
}

async function testScraperX() {
  const apiKey = env.SCRAPPER_X_API?.trim();
  if (!apiKey) return { skipped: true, reason: 'SCRAPPER_X_API not set' };

  // We don't have multiple keys for ScraperX today; still avoid logging the key.
  const apiKeyHash = hashApiKey(apiKey);

  const res = await fetch('https://api.scraperx.com/api/v1/google/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({ keyword: 'mvp development', country: 'us', language: 'en', limit: 3, page: 1 }),
    signal: AbortSignal.timeout(30_000)
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, bodySnippet: text.slice(0, 200) };

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Non-JSON response', bodySnippet: text.slice(0, 200) };
  }

  const organic = Array.isArray(json?.organic) ? json.organic.length : 0;
  const kg = json?.knowledge_graph ? true : false;

  return { ok: true, keyHashPrefix: apiKeyHash.slice(0, 8), counts: { organic, knowledgeGraph: kg } };
}

async function main() {
  console.log('Healthcheck started');

  const mysql = await checkMysql();
  console.log('MySQL: ok', mysql.missing.length ? { missingTables: mysql.missing } : {});

  const pg = await checkPostgres();
  console.log('Postgres: ok', pg.missing.length ? { missingTables: pg.missing } : {});

  const serpstack = await testSerpstack();
  console.log('Serpstack:', serpstack);

  const zenserp = await testZenserp();
  console.log('Zenserp:', zenserp);

  const scraperx = await testScraperX();
  console.log('ScraperX:', scraperx);

  console.log('Healthcheck finished');
}

await main()
  .catch((e) => {
    console.error('Healthcheck failed:', e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mysqlPool.end();
    await postgresPool.end();
  });
