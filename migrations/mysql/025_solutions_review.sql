-- Migration: AI-review columns for solutions pages. Distinct from the existing
-- reviewed_at/reviewed_by columns (022_solutions_pages.sql), which are reserved for
-- HUMAN sign-off and are never written by the automated reviewer.
--
-- Split into separate ALTER statements (not one multi-clause ALTER): referencing a
-- column added earlier in the SAME statement via AFTER isn't reliable on TiDB (same
-- class of gotcha as the in-place PRIMARY KEY changes noted in earlier migrations).
ALTER TABLE solutions
  ADD COLUMN ai_review_score INT NULL AFTER content_generated_at;

ALTER TABLE solutions
  ADD COLUMN ai_review_passed BOOLEAN NULL AFTER ai_review_score;

ALTER TABLE solutions
  ADD COLUMN ai_review_issues_json JSON NULL AFTER ai_review_passed;

ALTER TABLE solutions
  ADD COLUMN ai_reviewed_at TIMESTAMP NULL AFTER ai_review_issues_json;
