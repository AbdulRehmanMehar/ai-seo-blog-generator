-- Migration: post redirects for consolidation.
-- When near-duplicate posts are merged into a single survivor, the retired posts are
-- marked status='merged' and given redirect_to_slug = survivor's slug. The Next.js app
-- 301-redirects /blog/{slug} → /blog/{redirect_to_slug} for these. Because every live
-- query already filters status='published', merged posts drop out of the sitemap,
-- internal links, and index scans automatically. Merged posts are NOT 'to_be_deleted',
-- so the deletion cron never removes them (the redirect must keep working).

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS redirect_to_slug VARCHAR(255) NULL
    COMMENT 'Survivor slug to 301-redirect to (set when status=merged)';

ALTER TABLE posts
  MODIFY COLUMN status ENUM('draft','published','rewrite','to_be_deleted','merged')
    NOT NULL DEFAULT 'draft';

CREATE INDEX IF NOT EXISTS idx_posts_redirect ON posts (status, redirect_to_slug);
