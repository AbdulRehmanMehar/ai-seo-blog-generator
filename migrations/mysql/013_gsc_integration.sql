-- Migration: Google Search Console integration
-- Adds tables and columns to close the ranking feedback loop.

-- ──────────────────────────────────────────────────────────────
-- 1. GSC property URI on websites table
--    Authentication is via shared OAuth2 tokens in env vars
--    (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_ACCESS_TOKEN / GSC_REFRESH_TOKEN).
--    No per-site credential column needed.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE websites
  ADD COLUMN IF NOT EXISTS gsc_property_uri VARCHAR(255) NULL
    COMMENT 'GSC property URI e.g. sc-domain:primestrides.com' AFTER default_cta_url;

UPDATE websites SET gsc_property_uri = 'sc-domain:primestrides.com'
WHERE domain = 'primestrides.com';

UPDATE websites SET gsc_property_uri = 'sc-domain:theabdulrehman.com'
WHERE domain = 'theabdulrehman.com';

-- ──────────────────────────────────────────────────────────────
-- 2. GSC near-miss columns on keywords table
-- ──────────────────────────────────────────────────────────────
ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS gsc_sourced TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 if this keyword was discovered via GSC near-miss detection';

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS gsc_impressions INT NULL
    COMMENT 'Real monthly impressions from GSC at the time of discovery';

CREATE INDEX IF NOT EXISTS idx_keywords_gsc_sourced ON keywords (gsc_sourced);

-- ──────────────────────────────────────────────────────────────
-- 3. gsc_performance — raw fact table (page + query + date)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gsc_performance (
  id            CHAR(36)        NOT NULL,
  website_id    VARCHAR(36)     NOT NULL,
  page_url      VARCHAR(2048)   NOT NULL,
  query         VARCHAR(500)    NOT NULL,
  date          DATE            NOT NULL,
  clicks        INT             NOT NULL DEFAULT 0,
  impressions   INT             NOT NULL DEFAULT 0,
  ctr           DECIMAL(10, 6)  NOT NULL DEFAULT 0.000000,
  position      DECIMAL(8, 2)   NOT NULL DEFAULT 0.00,
  synced_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uniq_perf (website_id, page_url(512), query(255), date),
  INDEX idx_gsc_perf_website_date (website_id, date),
  INDEX idx_gsc_perf_page (website_id, page_url(512)),
  INDEX idx_gsc_perf_query (website_id, query(255)),
  INDEX idx_gsc_perf_position (website_id, position),

  CONSTRAINT fk_gsc_perf_website FOREIGN KEY (website_id) REFERENCES websites (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 4. gsc_page_metrics — daily aggregated page-level rollup
--    Used for decline detection (7-day vs prior-21-day comparison)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gsc_page_metrics (
  id              CHAR(36)       NOT NULL,
  website_id      VARCHAR(36)    NOT NULL,
  page_url        VARCHAR(2048)  NOT NULL,
  post_id         CHAR(36)       NULL COMMENT 'Linked post resolved by slug matching',
  period_start    DATE           NOT NULL,
  period_end      DATE           NOT NULL,
  total_clicks    INT            NOT NULL DEFAULT 0,
  total_impr      INT            NOT NULL DEFAULT 0,
  avg_ctr         DECIMAL(10, 6) NOT NULL DEFAULT 0.000000,
  avg_position    DECIMAL(8, 2)  NOT NULL DEFAULT 0.00,
  synced_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uniq_page_period (website_id, page_url(512), period_start, period_end),
  INDEX idx_gsc_page_post (post_id),
  INDEX idx_gsc_page_position_impr (website_id, avg_position, total_impr),

  CONSTRAINT fk_gsc_page_website FOREIGN KEY (website_id) REFERENCES websites (id),
  CONSTRAINT fk_gsc_page_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 5. gsc_opportunities — work queue for detected opportunities
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gsc_opportunities (
  id               CHAR(36)      NOT NULL,
  website_id       VARCHAR(36)   NOT NULL,
  opportunity_type ENUM('low_ctr', 'near_miss', 'declining') NOT NULL,
  post_id          CHAR(36)      NULL,
  page_url         VARCHAR(2048) NULL,
  query            VARCHAR(500)  NULL,
  metrics_json     JSON          NOT NULL COMMENT 'Snapshot of metrics at detection time',
  status           ENUM('pending', 'in_progress', 'resolved', 'dismissed') NOT NULL DEFAULT 'pending',
  priority         INT           NOT NULL DEFAULT 5 COMMENT '1=highest 10=lowest',
  detected_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at      TIMESTAMP     NULL,
  resolution_note  TEXT          NULL,

  PRIMARY KEY (id),
  INDEX idx_gsc_opp_status_priority (status, priority, detected_at),
  INDEX idx_gsc_opp_website_type (website_id, opportunity_type, status),

  CONSTRAINT fk_gsc_opp_website FOREIGN KEY (website_id) REFERENCES websites (id),
  CONSTRAINT fk_gsc_opp_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 6. content_refresh_queue — posts queued for GSC-triggered refresh
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_refresh_queue (
  id               CHAR(36)      NOT NULL,
  post_id          CHAR(36)      NOT NULL,
  website_id       VARCHAR(36)   NOT NULL,
  refresh_type     ENUM('full_refresh', 'ctr_optimize', 'section_expand') NOT NULL,
  trigger_type     ENUM('declining', 'low_ctr', 'near_miss', 'manual') NOT NULL,
  opportunity_id   CHAR(36)      NULL,
  gsc_context_json JSON          NULL COMMENT 'GSC data injected into the refresh prompt',
  status           ENUM('queued', 'processing', 'done', 'failed') NOT NULL DEFAULT 'queued',
  attempts         INT           NOT NULL DEFAULT 0,
  queued_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at       TIMESTAMP     NULL,
  completed_at     TIMESTAMP     NULL,
  error_message    TEXT          NULL,

  PRIMARY KEY (id),
  INDEX idx_refresh_status_queued (status, queued_at),

  CONSTRAINT fk_refresh_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_refresh_website FOREIGN KEY (website_id) REFERENCES websites (id),
  CONSTRAINT fk_refresh_opp FOREIGN KEY (opportunity_id) REFERENCES gsc_opportunities (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
