-- Migration: add an explicit CTA field to solutions pages. The original design
-- spec called for a "prominent, repeated" CTA as a defining structural
-- difference from blog posts (which have one CTA at the end) — this was
-- missed in 022_solutions_pages.sql; solutionsContentSchema had no cta field.
ALTER TABLE solutions
  ADD COLUMN cta_text VARCHAR(255) NULL AFTER faq_json;
