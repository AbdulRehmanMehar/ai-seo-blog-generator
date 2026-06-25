-- Migration: per-post Google index status, captured from the URL Inspection API.
-- Drives the "rewrite-to-get-indexed" remediation loop: posts are routed by their
-- index_state (orphaned vs low-value vs excluded vs indexed) to the matching fix.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS index_state VARCHAR(40) NULL
    COMMENT 'Normalized: indexed|discovered_not_indexed|crawled_not_indexed|unknown|excluded|error';

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS index_coverage_state VARCHAR(160) NULL
    COMMENT 'Raw coverageState string from the URL Inspection API';

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS index_checked_at TIMESTAMP NULL
    COMMENT 'When index_state was last refreshed (NULLs scanned first)';

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS index_remediation_count INT NOT NULL DEFAULT 0
    COMMENT 'How many times this post has been through indexing remediation';

CREATE INDEX IF NOT EXISTS idx_posts_index_state ON posts (status, index_state, index_checked_at);
