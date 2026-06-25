-- Migration: Content taxonomy (categories + tags) for SEO hub pages and internal linking.
--
-- Categories are a small CONTROLLED set of topic-cluster pillars (seeded below, one set
-- per website). Each post can belong to several categories (one flagged primary for clean
-- URLs/breadcrumbs). Tags are open but only become indexable once they cross a post-count
-- threshold (enforced in app code) to avoid spawning thin 1-post archive pages.

-- ──────────────────────────────────────────────────────────────
-- 1. categories — controlled pillars, each rendered as a hub page
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id                   CHAR(36)      NOT NULL,
  website_id           VARCHAR(36)   NOT NULL,
  name                 VARCHAR(100)  NOT NULL,
  slug                 VARCHAR(150)  NOT NULL,
  description          VARCHAR(500)  NULL COMMENT 'Short human tagline shown on the hub page',
  seo_content          MEDIUMTEXT    NULL COMMENT 'Unique generated hub-page body (filled by TaxonomyService)',
  meta_title           VARCHAR(255)  NULL,
  meta_description     VARCHAR(500)  NULL,
  post_count           INT           NOT NULL DEFAULT 0 COMMENT 'Published posts in this category',
  content_generated_at TIMESTAMP     NULL,
  content_post_count   INT           NOT NULL DEFAULT 0 COMMENT 'post_count at last content generation (staleness check)',
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_cat_slug (website_id, slug),
  INDEX idx_cat_website (website_id),
  CONSTRAINT fk_cat_website FOREIGN KEY (website_id) REFERENCES websites (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 2. tags — open taxonomy, gated to indexable once post_count >= threshold
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id                   CHAR(36)      NOT NULL,
  website_id           VARCHAR(36)   NOT NULL,
  name                 VARCHAR(100)  NOT NULL,
  slug                 VARCHAR(150)  NOT NULL,
  seo_content          MEDIUMTEXT    NULL,
  meta_title           VARCHAR(255)  NULL,
  meta_description     VARCHAR(500)  NULL,
  post_count           INT           NOT NULL DEFAULT 0,
  is_indexable         TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 once post_count crosses threshold',
  content_generated_at TIMESTAMP     NULL,
  content_post_count   INT           NOT NULL DEFAULT 0,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_tag_slug (website_id, slug),
  INDEX idx_tag_website (website_id),
  INDEX idx_tag_indexable (website_id, is_indexable),
  CONSTRAINT fk_tag_website FOREIGN KEY (website_id) REFERENCES websites (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 3. post_categories — many-to-many, one row flagged primary
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_categories (
  post_id     CHAR(36)   NOT NULL,
  category_id CHAR(36)   NOT NULL,
  is_primary  TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, category_id),
  INDEX idx_pc_category (category_id),
  CONSTRAINT fk_pc_post FOREIGN KEY (post_id) REFERENCES posts (id),
  CONSTRAINT fk_pc_category FOREIGN KEY (category_id) REFERENCES categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 4. post_tags — many-to-many
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_tags (
  post_id    CHAR(36)  NOT NULL,
  tag_id     CHAR(36)  NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, tag_id),
  INDEX idx_pt_tag (tag_id),
  CONSTRAINT fk_pt_post FOREIGN KEY (post_id) REFERENCES posts (id),
  CONSTRAINT fk_pt_tag FOREIGN KEY (tag_id) REFERENCES tags (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──────────────────────────────────────────────────────────────
-- 5. Seed the controlled category pillars for every existing website.
--    Idempotent via NOT EXISTS; seo_content is left NULL and generated later.
-- ──────────────────────────────────────────────────────────────
INSERT INTO categories (id, website_id, name, slug, description)
SELECT UUID(), w.id, t.name, t.slug, t.description
FROM websites w
CROSS JOIN (
            SELECT 'Legacy Modernization' AS name, 'legacy-modernization' AS slug, 'Migrating and rescuing aging codebases without breaking production' AS description
  UNION ALL SELECT 'AI Integration', 'ai-integration', 'Shipping real AI and LLM features into existing products'
  UNION ALL SELECT 'MVP and Product Development', 'mvp-product-development', 'Taking new products from idea to launched MVP'
  UNION ALL SELECT 'Technical Due Diligence', 'technical-due-diligence', 'Codebase and architecture reviews for funding and acquisitions'
  UNION ALL SELECT 'Engineering Leadership', 'engineering-leadership', 'Fractional CTO guidance and engineering team direction'
  UNION ALL SELECT 'Software Cost and Pricing', 'software-cost-pricing', 'What software actually costs and how to budget for it'
  UNION ALL SELECT 'Architecture and Scaling', 'architecture-scaling', 'Designing systems that stay fast and reliable as they grow'
  UNION ALL SELECT 'Compliance and Security', 'compliance-security', 'Building software that meets security and regulatory requirements'
  UNION ALL SELECT 'Team and Hiring', 'team-hiring', 'Finding, vetting and structuring software teams'
  UNION ALL SELECT 'Product Strategy', 'product-strategy', 'Deciding what to build and why before writing code'
) t
WHERE NOT EXISTS (
  SELECT 1 FROM categories c WHERE c.website_id = w.id AND c.slug = t.slug
);
