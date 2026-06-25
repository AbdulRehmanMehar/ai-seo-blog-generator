/**
 * INDEX RESCUE — rewrite posts Google refused to index (discovered/crawled - not indexed)
 * so they become index-worthy: de-clickbait the title, add real information gain, A2 voice.
 *
 *   npx tsx scripts/index-rescue.ts            # default 10 (a test batch)
 *   npx tsx scripts/index-rescue.ts 50         # process 50
 *
 * Oldest-remediated first. Preserves the slug. Re-humanizes (A2 + no em dash), re-embeds,
 * and clears index_state so the next census re-checks whether Google indexed it.
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { env } from '../src/config/env.js';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { postgresPool } from '../src/db/postgresPool.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { EmbeddingStore } from '../src/embeddings/embeddingStore.js';
import { postHumanizer } from '../src/services/postHumanizer.js';
import { indexRescuePrompt } from '../src/prompts/contentRefresh.js';
import { safeJsonParse } from '../src/utils/json.js';
import type { BlogPostStructure } from '../src/prompts/blogGeneration.js';

async function main() {
  const limit = Number(process.argv[2] ?? 10);
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  const gemini = new GeminiClient({
    rateLimiter: new GeminiRateLimiter(mysqlPool, apiKeys),
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_PROVIDER === 'openrouter' ? 0 : env.LLM_MIN_SECONDS_BETWEEN_REQUESTS,
  });
  const embeddings = new EmbeddingStore(postgresPool);

  console.log(`Index-rescue via ${env.LLM_PROVIDER === 'openrouter' ? env.OPENROUTER_MODEL : env.GEMINI_GENERATION_MODEL} | batch ${limit}\n`);

  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT id, slug, primary_keyword, content_json, target_icp
       FROM posts
      WHERE status = 'published'
        AND index_state IN ('discovered_not_indexed', 'crawled_not_indexed')
      ORDER BY index_remediation_count ASC, updated_at ASC
      LIMIT ?`,
    [limit]
  );

  let ok = 0, fail = 0;
  for (const r of rows as any[]) {
    try {
      const current = (typeof r.content_json === 'string' ? JSON.parse(r.content_json) : r.content_json) as BlogPostStructure;
      const prompt = indexRescuePrompt({ currentPost: current, keyword: String(r.primary_keyword), targetIcp: r.target_icp ?? null });
      const raw = await gemini.generateText({
        systemInstruction: prompt.system, userPrompt: prompt.user, temperature: 0.5, maxOutputTokens: 8192,
      });
      const parsed = safeJsonParse(raw) as BlogPostStructure;
      if (!parsed?.title || !Array.isArray(parsed.sections)) throw new Error('invalid structure');

      parsed.slug = current.slug; // slug is immutable
      const { post: humanized } = postHumanizer.humanize(parsed);

      await mysqlPool.query<ResultSetHeader>(
        `UPDATE posts SET content_json = ?, title = ?, meta_title = ?, meta_description = ?,
                index_remediation_count = index_remediation_count + 1, index_state = NULL, updated_at = NOW()
          WHERE id = ?`,
        [
          JSON.stringify(humanized),
          humanized.title,
          humanized.meta?.title ?? humanized.title,
          humanized.meta?.description ?? '',
          String(r.id),
        ]
      );

      try {
        const emb = await gemini.embedText(`${humanized.title}\n${humanized.meta?.description ?? ''}\n${humanized.hero?.hook ?? ''}`);
        await embeddings.upsert({ entityType: 'post', entityId: String(r.id), embedding: emb });
      } catch { /* re-embed best-effort */ }

      ok++;
      console.log(`✓ "${String(current.title).slice(0, 46)}"\n   → "${humanized.title.slice(0, 60)}"`);
    } catch (e) {
      fail++;
      console.log(`✗ ${r.id}: ${e instanceof Error ? e.message.slice(0, 90) : String(e)}`);
    }
  }

  console.log(`\nRescued ${ok}, failed ${fail}. (index_state cleared → re-run the census to see if Google indexes them.)`);
  await mysqlPool.end();
  await postgresPool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  try { await postgresPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
