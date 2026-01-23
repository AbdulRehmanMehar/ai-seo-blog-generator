import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import type { GeminiClient } from '../llm/geminiClient.js';
import type { EmbeddingStore } from '../embeddings/embeddingStore.js';

export interface DuplicateCheckerDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
  embeddings: EmbeddingStore;
  threshold: number;
}

export class DuplicateChecker {
  constructor(private readonly deps: DuplicateCheckerDeps) {}

  async isDuplicateTopic(topicId: string): Promise<boolean> {
    const [rows] = await this.deps.pool.query<RowDataPacket[]>('SELECT topic, keyword_id FROM topics WHERE id = ?', [topicId]);
    const row = rows[0] as any;
    const candidate = row?.topic != null ? String(row.topic) : null;
    const keywordId = row?.keyword_id != null ? String(row.keyword_id) : null;
    if (!candidate) return false;
    const embedding = await this.deps.gemini.embedText(candidate);

    const sim = await this.deps.embeddings.bestSimilarity({
      embedding,
      exclude: { entityType: 'topic', entityId: topicId }
    });

    const similarity = sim.best;
    const isDup = similarity >= this.deps.threshold;

    if (isDup) {
      await this.deps.pool.query(`UPDATE topics SET topic = CONCAT(topic, ' (rejected-duplicate)') WHERE id = ?`, [topicId]);
      if (keywordId) {
        await this.deps.pool.query(`UPDATE keywords SET status = 'rejected' WHERE id = ?`, [keywordId]);
      }
      // eslint-disable-next-line no-console
      console.log(`DuplicateChecker: topic ${topicId} rejected similarity=${similarity.toFixed(3)}`);
    }

    return isDup;
  }
}
