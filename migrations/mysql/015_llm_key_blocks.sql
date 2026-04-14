-- Migration: Persistently block bad/revoked LLM API keys
-- Lets the app survive revoked keys across restarts.

CREATE TABLE IF NOT EXISTS llm_api_key_blocks (
  api_key_hash VARCHAR(16) NOT NULL PRIMARY KEY,
  disabled_until TIMESTAMP NOT NULL,
  reason VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_disabled_until (disabled_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

