import type { Pool } from 'pg';

export type EmbeddingEntityType = 'topic' | 'post';

export class EmbeddingStore {
  constructor(private readonly pool: Pool) {}

  async upsert(args: { entityType: EmbeddingEntityType; entityId: string; embedding: number[] }): Promise<void> {
    const embeddingLiteral = `[${args.embedding.join(',')}]`;

    await this.pool.query(
      `
      INSERT INTO embeddings(entity_type, entity_id, embedding)
      VALUES ($1, $2, $3::vector)
      ON CONFLICT (entity_type, entity_id)
      DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = now()
      `,
      [args.entityType, args.entityId, embeddingLiteral]
    );
  }

  async bestSimilarity(args: { embedding: number[]; exclude?: { entityType: EmbeddingEntityType; entityId: string } }): Promise<{ bestTopic: number; bestPost: number; best: number }> {
    const embeddingLiteral = `[${args.embedding.join(',')}]`;

    const excludeType = args.exclude?.entityType ?? null;
    const excludeId = args.exclude?.entityId ?? null;

    const res = await this.pool.query<{ best_topic: number; best_post: number; best: number }>(
      `
      WITH best_posts AS (
        SELECT (1 - (embedding <=> $1::vector)) AS similarity
        FROM embeddings
        WHERE entity_type = 'post'
        ORDER BY embedding <=> $1::vector ASC
        LIMIT 1
      ), best_topics AS (
        SELECT (1 - (embedding <=> $1::vector)) AS similarity
        FROM embeddings
        WHERE entity_type = 'topic'
          AND NOT (entity_type = COALESCE($2::text, entity_type) AND entity_id = COALESCE($3::text, entity_id))
        ORDER BY embedding <=> $1::vector ASC
        LIMIT 1
      )
      SELECT
        COALESCE((SELECT similarity FROM best_topics), 0) AS best_topic,
        COALESCE((SELECT similarity FROM best_posts), 0) AS best_post,
        GREATEST(
          COALESCE((SELECT similarity FROM best_topics), 0),
          COALESCE((SELECT similarity FROM best_posts), 0)
        ) AS best
      `,
      [embeddingLiteral, excludeType, excludeId]
    );

    return {
      bestTopic: res.rows[0]?.best_topic ?? 0,
      bestPost: res.rows[0]?.best_post ?? 0,
      best: res.rows[0]?.best ?? 0
    };
  }
}
