-- Service-level solutions pages (2026-08-01): one standalone sales page per service
-- (/solutions/{serviceSlug}), the primary tier of the solutions-pages architecture —
-- niche pages (solutions table) now generate only where curated case-study proof
-- exists, and everything else is covered by the service-level page. Content lives in
-- one JSON blob (full SolutionsPageContent shape incl. meta_title/meta_description)
-- rather than exploded columns: the services table is curated config, and the page
-- content is a single generated artifact consumed whole by the frontend.
--
-- Each ALTER is its own statement: TiDB failed migration 025 when one multi-clause
-- ALTER referenced a column added earlier in the same statement.

ALTER TABLE services ADD COLUMN content_json JSON NULL;

ALTER TABLE services ADD COLUMN page_status VARCHAR(16) NOT NULL DEFAULT 'none';

ALTER TABLE services ADD COLUMN cta_url VARCHAR(512) NULL;

ALTER TABLE services ADD COLUMN content_generated_at TIMESTAMP NULL;

ALTER TABLE services ADD COLUMN ai_review_score INT NULL;

ALTER TABLE services ADD COLUMN ai_review_passed BOOLEAN NULL;

ALTER TABLE services ADD COLUMN ai_review_issues_json JSON NULL;

ALTER TABLE services ADD COLUMN ai_reviewed_at TIMESTAMP NULL;

ALTER TABLE services ADD COLUMN reviewed_by VARCHAR(255) NULL;

ALTER TABLE services ADD COLUMN reviewed_at TIMESTAMP NULL;
