-- Migration: Prompt learning system
-- Stores learned rules from review failures to improve future generation

CREATE TABLE IF NOT EXISTS prompt_learnings (
  id CHAR(36) PRIMARY KEY,
  category VARCHAR(100) NOT NULL,  -- e.g., 'vocabulary', 'structure', 'formatting'
  rule_type VARCHAR(50) NOT NULL,  -- e.g., 'forbidden_word', 'max_length', 'required_pattern'
  rule_value TEXT NOT NULL,        -- e.g., 'leverage', '150', 'must include mid-article CTA'
  reason TEXT NOT NULL,            -- Why this rule exists (from reviews)
  failure_count INT NOT NULL DEFAULT 1,
  last_failure_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  
  -- Unique constraint on category + rule_type + rule_value
  UNIQUE KEY uniq_rule (category, rule_type, rule_value(255)),
  INDEX idx_learnings_active (is_active, failure_count DESC),
  INDEX idx_learnings_category (category, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Track which posts contributed to which learnings (for analysis)
CREATE TABLE IF NOT EXISTS learning_sources (
  id CHAR(36) PRIMARY KEY,
  learning_id CHAR(36) NOT NULL,
  post_id CHAR(36) NOT NULL,
  review_id CHAR(36) NOT NULL,
  issue_code VARCHAR(50) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_sources_learning (learning_id),
  INDEX idx_sources_post (post_id),
  CONSTRAINT fk_sources_learning FOREIGN KEY (learning_id) REFERENCES prompt_learnings(id) ON DELETE CASCADE,
  CONSTRAINT fk_sources_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_sources_review FOREIGN KEY (review_id) REFERENCES post_reviews(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
