-- MySQL is used for content + stats + keyword/topic/post metadata

CREATE TABLE IF NOT EXISTS schema_migrations_mysql (
  id VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS keywords (
  id CHAR(36) PRIMARY KEY,
  keyword VARCHAR(255) NOT NULL,
  volume INT NULL,
  difficulty INT NULL,
  cpc DECIMAL(10,2) NULL,
  intent VARCHAR(64) NULL,
  status ENUM('new','used','rejected') NOT NULL DEFAULT 'new',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_keyword (keyword)
);

CREATE TABLE IF NOT EXISTS topics (
  id CHAR(36) PRIMARY KEY,
  keyword_id CHAR(36) NOT NULL,
  topic VARCHAR(512) NOT NULL,
  outline_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_topics_keyword (keyword_id),
  CONSTRAINT fk_topics_keyword FOREIGN KEY (keyword_id) REFERENCES keywords(id)
);

CREATE TABLE IF NOT EXISTS posts (
  id CHAR(36) PRIMARY KEY,
  topic_id CHAR(36) NOT NULL,
  title VARCHAR(512) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  primary_keyword VARCHAR(255) NOT NULL,
  meta_title VARCHAR(512) NOT NULL,
  meta_description TEXT NOT NULL,
  content_markdown MEDIUMTEXT NOT NULL,
  status ENUM('draft','published') NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_slug (slug),
  INDEX idx_posts_status_created (status, created_at),
  CONSTRAINT fk_posts_topic FOREIGN KEY (topic_id) REFERENCES topics(id)
);

CREATE TABLE IF NOT EXISTS llm_usage_daily (
  day DATE PRIMARY KEY,
  request_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Optional: track monthly SERP usage
CREATE TABLE IF NOT EXISTS serp_usage_monthly (
  provider ENUM('serpstack','zenserp','scraperx') NOT NULL,
  month_year CHAR(7) NOT NULL, -- YYYY-MM
  request_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, month_year)
);
