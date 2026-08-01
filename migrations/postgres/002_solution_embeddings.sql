-- Near-duplicate detection for solutions pages, scoped to "other niches under the
-- same service" rather than a global corpus (see migrations/mysql/022_solutions_pages.sql
-- for the service/niche/solutions schema this supports). Kept as its own table rather
-- than widening embeddings.entity_type, since solutions pages compare on a different
-- scope (same service_id) and a much smaller corpus (max ~40 rows) than blog content.
--
-- No ivfflat index: that index type is approximate and needs a large row count per
-- list to behave well. This table will never exceed ~40 rows, and every query is
-- already scoped to a single service_id (at most ~8 rows) — a sequential scan is both
-- simpler and exact.
CREATE TABLE IF NOT EXISTS solution_embeddings (
  id         TEXT NOT NULL,          -- solutions.id (MySQL UUID, as text)
  service_id TEXT NOT NULL,          -- solutions.service_id, denormalized so similarity
                                      -- queries can scope to "same service" without a
                                      -- cross-database join (solutions lives in MySQL)
  embedding  vector(768) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS solution_embeddings_service ON solution_embeddings (service_id);
