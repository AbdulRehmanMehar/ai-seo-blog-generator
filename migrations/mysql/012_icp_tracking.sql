-- Migration: Add target_icp to topics and posts for ICP-aware content generation
-- Each topic and post is now written to attract a specific Ideal Client Profile persona.

ALTER TABLE topics
  ADD COLUMN target_icp VARCHAR(100) NULL COMMENT 'ICP persona name (e.g. Modernizing Michael)' AFTER outline_json;

ALTER TABLE posts
  ADD COLUMN target_icp VARCHAR(100) NULL COMMENT 'ICP persona name inherited from topic' AFTER meta_description;

-- Index for filtering/reporting by ICP
CREATE INDEX idx_topics_icp ON topics (target_icp);
CREATE INDEX idx_posts_icp ON posts (target_icp);
