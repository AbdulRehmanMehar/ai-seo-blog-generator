-- Cache table for AI-generated seed keywords
-- Stores seeds once per day to avoid redundant API calls
CREATE TABLE IF NOT EXISTS keyword_seed_cache (
  cache_key VARCHAR(50) PRIMARY KEY,
  seeds TEXT NOT NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_generated_at (generated_at)
);
