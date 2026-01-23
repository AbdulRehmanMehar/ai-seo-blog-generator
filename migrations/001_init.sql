-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Track migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keywords discovered for SEO targeting
CREATE TABLE IF NOT EXISTS keywords (
  id BIGSERIAL PRIMARY KEY,
  keyword TEXT NOT NULL UNIQUE,
  volume INTEGER,
  difficulty REAL,
  cpc REAL,
  intent TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Topics selected from keywords
CREATE TABLE IF NOT EXISTS topics (
  id BIGSERIAL PRIMARY KEY,
  keyword_id BIGINT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  outline JSONB NOT NULL,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generated posts
CREATE TABLE IF NOT EXISTS posts (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  primary_keyword TEXT NOT NULL,
  meta_title TEXT NOT NULL,
  meta_description TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  embedding vector(768),
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(status);
CREATE INDEX IF NOT EXISTS idx_topics_keyword_id ON topics(keyword_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);

-- Vector indexes for similarity search (cosine)
CREATE INDEX IF NOT EXISTS idx_topics_embedding_cosine ON topics USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_posts_embedding_cosine ON posts USING ivfflat (embedding vector_cosine_ops);
