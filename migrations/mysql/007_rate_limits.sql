-- Migration: Add comprehensive rate limit tracking for Gemini API
-- Tracks RPM (requests per minute), TPM (tokens per minute), RPD (requests per day)
-- Separates generation and embedding model usage

-- Per-minute tracking for RPM and TPM limits
CREATE TABLE IF NOT EXISTS llm_usage_minute (
  minute_bucket DATETIME NOT NULL,        -- Truncated to minute (e.g., 2026-01-23 12:34:00)
  api_key_hash VARCHAR(16) NOT NULL,
  model_type ENUM('generation', 'embedding') NOT NULL DEFAULT 'generation',
  request_count INT NOT NULL DEFAULT 0,
  token_count INT NOT NULL DEFAULT 0,     -- Input + output tokens
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (minute_bucket, api_key_hash, model_type),
  INDEX idx_minute_key (api_key_hash, minute_bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Create new daily tracking table with model_type support
-- (TiDB doesn't allow modifying clustered primary keys, so create fresh table)
CREATE TABLE IF NOT EXISTS llm_usage_daily_v3 (
  day DATE NOT NULL,
  api_key_hash VARCHAR(16) NOT NULL DEFAULT 'default',
  model_type ENUM('generation', 'embedding') NOT NULL DEFAULT 'generation',
  request_count INT NOT NULL DEFAULT 0,
  token_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (day, api_key_hash, model_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Copy existing data from old table (all as 'generation' type)
INSERT IGNORE INTO llm_usage_daily_v3 (day, api_key_hash, model_type, request_count, token_count, created_at, updated_at)
SELECT day, api_key_hash, 'generation', request_count, 0, created_at, updated_at FROM llm_usage_daily;

-- Drop old table and rename new one
DROP TABLE IF EXISTS llm_usage_daily;
ALTER TABLE llm_usage_daily_v3 RENAME TO llm_usage_daily;

-- Store rate limit configurations per model
CREATE TABLE IF NOT EXISTS llm_rate_limits (
  model_name VARCHAR(64) NOT NULL,
  model_type ENUM('generation', 'embedding') NOT NULL,
  rpm_limit INT NOT NULL DEFAULT 10,      -- Requests per minute
  tpm_limit INT NOT NULL DEFAULT 250000,  -- Tokens per minute
  rpd_limit INT NOT NULL DEFAULT 20,      -- Requests per day
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (model_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Insert default rate limits for Gemini free tier
INSERT INTO llm_rate_limits (model_name, model_type, rpm_limit, tpm_limit, rpd_limit) VALUES
  ('gemini-2.5-flash', 'generation', 5, 250000, 20),
  ('gemini-2.5-flash-lite', 'generation', 10, 250000, 20),
  ('gemini-1.5-flash', 'generation', 15, 1000000, 1500),
  ('gemini-1.5-pro', 'generation', 2, 32000, 50),
  ('gemini-embedding-001', 'embedding', 100, 30000, 1000),
  ('text-embedding-004', 'embedding', 100, 30000, 1000)
ON DUPLICATE KEY UPDATE
  rpm_limit = VALUES(rpm_limit),
  tpm_limit = VALUES(tpm_limit),
  rpd_limit = VALUES(rpd_limit);
