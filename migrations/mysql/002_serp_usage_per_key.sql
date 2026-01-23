-- Track SERP usage per API key (store only hash, not the raw key)
-- TiDB can restrict DROP PRIMARY KEY on clustered indexes, so migrate via table swap.

CREATE TABLE IF NOT EXISTS serp_usage_monthly_v2 (
  provider ENUM('serpstack','zenserp','scraperx') NOT NULL,
  api_key_hash CHAR(64) NOT NULL,
  month_year CHAR(7) NOT NULL,
  request_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, api_key_hash, month_year)
);

INSERT INTO serp_usage_monthly_v2(provider, api_key_hash, month_year, request_count, updated_at)
SELECT provider, 'legacy', month_year, request_count, updated_at
FROM serp_usage_monthly
ON DUPLICATE KEY UPDATE
  request_count = VALUES(request_count),
  updated_at = VALUES(updated_at);

DROP TABLE IF EXISTS serp_usage_monthly_old;
RENAME TABLE serp_usage_monthly TO serp_usage_monthly_old, serp_usage_monthly_v2 TO serp_usage_monthly;
DROP TABLE IF EXISTS serp_usage_monthly_old;
