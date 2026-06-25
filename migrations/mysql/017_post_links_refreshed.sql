-- Migration: track when a post's internal links were last (re)built.
-- Lets the indexing step rebuild internalLinks for posts that were never linked or whose
-- links were wiped by a rewrite, and periodically refresh links as the cluster grows —
-- without re-touching the same rows every run.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS links_refreshed_at TIMESTAMP NULL
    COMMENT 'When content_json.internalLinks was last rebuilt by TaxonomyService' AFTER updated_at;

CREATE INDEX IF NOT EXISTS idx_posts_links_refreshed ON posts (status, links_refreshed_at);
