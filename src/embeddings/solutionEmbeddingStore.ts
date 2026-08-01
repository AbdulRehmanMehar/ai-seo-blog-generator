import type { Pool } from 'pg';

/**
 * Near-duplicate detection for solutions pages, scoped to "other niches under the
 * same service" — see migrations/postgres/002_solution_embeddings.sql for why this
 * is a separate table from the blog's shared `embeddings` table rather than a widened
 * entity_type.
 */
export class SolutionEmbeddingStore {
  constructor(private readonly pool: Pool) {}

  async upsert(args: { id: string; serviceId: string; embedding: number[] }): Promise<void> {
    const embeddingLiteral = `[${args.embedding.join(',')}]`;
    await this.pool.query(
      `INSERT INTO solution_embeddings(id, service_id, embedding)
       VALUES ($1, $2, $3::vector)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, service_id = EXCLUDED.service_id, updated_at = now()`,
      [args.id, args.serviceId, embeddingLiteral]
    );
  }

  /** Nearest-neighbor cosine similarity among OTHER solutions for the same service only. */
  async bestSimilarityForService(args: {
    embedding: number[];
    serviceId: string;
    excludeId: string | null;
  }): Promise<{ bestId: string | null; best: number }> {
    const embeddingLiteral = `[${args.embedding.join(',')}]`;
    const { rows } = await this.pool.query(
      `SELECT id, (1 - (embedding <=> $1::vector)) AS similarity
       FROM solution_embeddings
       WHERE service_id = $2 AND id IS DISTINCT FROM $3
       ORDER BY embedding <=> $1::vector ASC
       LIMIT 1`,
      [embeddingLiteral, args.serviceId, args.excludeId]
    );
    return rows[0] ? { bestId: rows[0].id, best: Number(rows[0].similarity) } : { bestId: null, best: 0 };
  }
}
