import { mysqlPool } from '../src/db/mysqlPool.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { GeminiRateLimiter } from '../src/llm/rateLimiter.js';
import { parseGeminiApiKeys } from '../src/llm/keyManager.js';
import { KeywordService } from '../src/services/keywordService.js';
import { env } from '../src/config/env.js';

async function main() {
  console.log('=== KEYWORD DISCOVERY TEST ===');
  
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  console.log('API Keys available:', apiKeys.length);
  
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: 2
  });
  
  const keywordService = new KeywordService({ pool: mysqlPool, gemini });
  
  console.log('\nStarting keyword discovery...\n');
  const result = await keywordService.discoverAndStoreKeywords();
  
  console.log('\n=== RESULTS ===');
  console.log('Discovered:', result.discovered);
  console.log('Filtered:', result.filtered);
  console.log('Inserted:', result.inserted);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
