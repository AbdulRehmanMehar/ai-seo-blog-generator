-- Migration: Add per-API-key tracking for multiple Gemini keys
-- TiDB doesn't support modifying clustered primary keys, so we create a new table

-- Create new table with multi-key support
CREATE TABLE IF NOT EXISTS llm_usage_daily_v2 (
  day DATE NOT NULL,
  api_key_hash VARCHAR(16) NOT NULL DEFAULT 'default',
  request_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (day, api_key_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Copy existing data from old table (if any) - note old table only has updated_at
INSERT IGNORE INTO llm_usage_daily_v2 (day, api_key_hash, request_count, updated_at)
SELECT day, 'default', request_count, updated_at FROM llm_usage_daily;

-- Drop old table and rename new one
DROP TABLE IF EXISTS llm_usage_daily;
ALTER TABLE llm_usage_daily_v2 RENAME TO llm_usage_daily;
