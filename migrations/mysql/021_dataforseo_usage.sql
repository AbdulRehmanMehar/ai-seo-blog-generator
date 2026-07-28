-- Extend the SERP usage provider enum so DataForSEO API spend is metered
-- through the same monthly per-key tracking as the free SERP providers.
ALTER TABLE serp_usage_monthly
  MODIFY provider ENUM('serpstack','zenserp','scraperx','dataforseo') NOT NULL;
