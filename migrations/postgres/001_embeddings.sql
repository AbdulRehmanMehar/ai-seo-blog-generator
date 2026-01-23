-- Postgres is used only for embeddings + similarity search

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS schema_migrations_pg (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Store embeddings for entities stored in MySQL
CREATE TABLE IF NOT EXISTS embeddings (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('topic', 'post')),
  entity_id TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

-- Similarity index (cosine distance)
CREATE INDEX IF NOT EXISTS embeddings_embedding_ivfflat
ON embeddings
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
