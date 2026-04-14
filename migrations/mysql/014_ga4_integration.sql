-- Migration: Google Analytics 4 integration (property id per website)
-- Uses shared OAuth2 credentials in env (same refresh token as GSC).

ALTER TABLE websites
  ADD COLUMN ga4_property_id VARCHAR(32) NULL
    COMMENT 'GA4 numeric property id (e.g. 123456789) for Analytics Data API' AFTER gsc_property_uri;

-- If you only have a single GA4 property, you can leave per-website ids NULL
-- and set GA4_PROPERTY_ID in env as a global fallback.

