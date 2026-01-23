-- Migration: Add review system for post quality control
-- Adds new statuses and review tracking table

-- Step 1: Add new status values to posts table
-- TiDB doesn't support ALTER COLUMN for ENUM, so we recreate the table

CREATE TABLE IF NOT EXISTS posts_v2 (
  id CHAR(36) PRIMARY KEY,
  topic_id CHAR(36) NOT NULL,
  title VARCHAR(512) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  primary_keyword VARCHAR(255) NOT NULL,
  meta_title VARCHAR(512) NOT NULL,
  meta_description TEXT NOT NULL,
  content_json JSON NULL,
  status ENUM('draft', 'published', 'rewrite', 'to_be_deleted') NOT NULL DEFAULT 'draft',
  rewrite_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_slug (slug),
  INDEX idx_posts_status_created (status, created_at),
  CONSTRAINT fk_posts_v2_topic FOREIGN KEY (topic_id) REFERENCES topics(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Copy existing data (all existing posts keep their status, start with 0 rewrites)
INSERT INTO posts_v2 (id, topic_id, title, slug, primary_keyword, meta_title, meta_description, content_json, status, rewrite_count, created_at, updated_at)
SELECT 
  id, topic_id, title, slug, primary_keyword, meta_title, meta_description, 
  content_json,
  CASE WHEN status = 'draft' THEN 'draft' ELSE 'published' END,
  0, created_at, updated_at
FROM posts;

-- Swap tables
DROP TABLE IF EXISTS posts_old;
RENAME TABLE posts TO posts_old, posts_v2 TO posts;
DROP TABLE IF EXISTS posts_old;

-- Step 2: Create post_reviews table for tracking review history
CREATE TABLE IF NOT EXISTS post_reviews (
  id CHAR(36) PRIMARY KEY,
  post_id CHAR(36) NOT NULL,
  attempt_number INT NOT NULL DEFAULT 1,
  score INT NOT NULL DEFAULT 0,
  passed BOOLEAN NOT NULL DEFAULT FALSE,
  issues_json JSON NOT NULL,
  rewrite_instructions TEXT NULL,
  reviewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_reviews_post (post_id),
  INDEX idx_reviews_passed (passed, reviewed_at),
  CONSTRAINT fk_reviews_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
