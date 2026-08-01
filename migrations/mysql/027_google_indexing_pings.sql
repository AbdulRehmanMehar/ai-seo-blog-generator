-- Ledger of URLs pinged to the Google Indexing API (2026-08-01), so the cron
-- indexing step only pings a URL when its content actually changed since the
-- last ping. Without this, the 2-day INDEXING_LOOKBACK_DAYS window x a cron
-- that runs several times a day would re-ping the same URLs every run and
-- exhaust the API's 200-requests/day project quota on duplicates.
CREATE TABLE IF NOT EXISTS google_indexing_pings (
  url            VARCHAR(500) NOT NULL,
  last_pinged_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (url)
);
