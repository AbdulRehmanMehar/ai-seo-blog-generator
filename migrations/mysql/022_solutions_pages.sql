-- Migration: Solutions pages (service x niche landing pages), commercial/mid-funnel
-- content distinct from the blog. Follows the categories/tags precedent (016_taxonomy.sql):
-- surrogate id, website_id FK + index, unique(website_id, slug).
--
-- services: a SMALL, hand-curated set of service pillars per website (not AI-generated).
-- niches: a curated industry list per website. AI may propose candidates later, but only
--         rows with status='approved' are eligible for solution-page generation.
-- solutions: one row per (service, niche) combination that has been generated for.

-- ──────────────────────────────────────────────────────────────
-- 1. services — controlled pillars, hand-authored per website
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id           CHAR(36)      NOT NULL,
  website_id   VARCHAR(36)   NOT NULL,
  name         VARCHAR(100)  NOT NULL,
  slug         VARCHAR(150)  NOT NULL,
  short_pitch  VARCHAR(500)  NULL COMMENT 'One-line description of what this service covers',
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_service_slug (website_id, slug),
  INDEX idx_service_website (website_id),
  CONSTRAINT fk_service_website FOREIGN KEY (website_id) REFERENCES websites (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ──────────────────────────────────────────────────────────────
-- 2. niches — curated industry list per website
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS niches (
  id               CHAR(36)      NOT NULL,
  website_id       VARCHAR(36)   NOT NULL,
  name             VARCHAR(100)  NOT NULL,
  slug             VARCHAR(150)  NOT NULL,
  context_json     JSON          NULL COMMENT 'Optional industry vocabulary/constraints to ground generation',
  default_icp_name VARCHAR(100)  NULL COMMENT 'Matches an icps.json persona_name for buyer-psychology grounding',
  status           ENUM('proposed','approved','rejected') NOT NULL DEFAULT 'approved',
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_niche_slug (website_id, slug),
  INDEX idx_niche_website (website_id, status),
  CONSTRAINT fk_niche_website FOREIGN KEY (website_id) REFERENCES websites (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ──────────────────────────────────────────────────────────────
-- 3. solutions — one row per (service, niche); the actual landing page content
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS solutions (
  id                    CHAR(36)      NOT NULL,
  website_id            VARCHAR(36)   NOT NULL,
  service_id            CHAR(36)      NOT NULL,
  niche_id              CHAR(36)      NOT NULL,
  headline              VARCHAR(255)  NULL,
  subheadline           VARCHAR(500)  NULL,
  pain_points_json      JSON          NULL,
  approach_json         JSON          NULL,
  proof_points_json     JSON          NULL,
  faq_json              JSON          NULL,
  target_keywords_json  JSON          NULL COMMENT 'Real DataForSEO keyword/SERP research used to ground this page',
  meta_title            VARCHAR(255)  NULL,
  meta_description      VARCHAR(500)  NULL,
  status                ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  generated_by          ENUM('ai','ai+human') NOT NULL DEFAULT 'ai',
  reviewed_at           TIMESTAMP     NULL,
  reviewed_by           VARCHAR(100)  NULL,
  content_generated_at  TIMESTAMP     NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_sol_service_niche (service_id, niche_id),
  INDEX idx_sol_website (website_id, status),
  CONSTRAINT fk_sol_website FOREIGN KEY (website_id) REFERENCES websites (id),
  CONSTRAINT fk_sol_service FOREIGN KEY (service_id) REFERENCES services (id),
  CONSTRAINT fk_sol_niche FOREIGN KEY (niche_id) REFERENCES niches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ──────────────────────────────────────────────────────────────
-- 4. Seed services + niches for theabdulrehman.com only. Both lists are drawn
--    directly from data/brand.json (target_market.sweet_spot_problems and
--    target_market.who_we_serve) rather than invented, since this is a personal
--    brand with explicit rules against generic/tech-led positioning.
--    Idempotent via NOT EXISTS.
-- ──────────────────────────────────────────────────────────────
INSERT INTO services (id, website_id, name, slug, short_pitch)
SELECT UUID(), w.id, t.name, t.slug, t.short_pitch
FROM websites w
CROSS JOIN (
            SELECT 'Booking, Scheduling and Intake Systems' AS name, 'booking-scheduling-intake' AS slug, 'Fixing booking, scheduling, and intake flows that lose customers' AS short_pitch
  UNION ALL SELECT 'Systems Integration', 'systems-integration', 'Connecting disconnected tools so data stops being re-typed by hand'
  UNION ALL SELECT 'Workflow and AI Automation', 'workflow-ai-automation', 'Automating manual workflows and repetitive queues with AI assistants'
  UNION ALL SELECT 'Website and Web App Modernization', 'website-web-app-modernization', 'Replacing slow or aging websites and web apps'
  UNION ALL SELECT 'Customer Portals and Dashboards', 'customer-portals-dashboards', 'Building customer portals and internal dashboards that replace manual reporting'
) t
WHERE w.domain = 'theabdulrehman.com'
  AND NOT EXISTS (SELECT 1 FROM services s WHERE s.website_id = w.id AND s.slug = t.slug);

INSERT INTO niches (id, website_id, name, slug, default_icp_name, status)
SELECT UUID(), w.id, t.name, t.slug, t.default_icp_name, 'approved'
FROM websites w
CROSS JOIN (
            SELECT 'Hospitality' AS name, 'hospitality' AS slug, 'Owner Omar' AS default_icp_name
  UNION ALL SELECT 'Veterinary and Med Spa Practices', 'veterinary-med-spa', 'Proprietor Priya'
  UNION ALL SELECT 'Real Estate', 'real-estate', 'Owner Omar'
  UNION ALL SELECT 'Recruiting and Staffing', 'recruiting-staffing', 'Owner Omar'
  UNION ALL SELECT 'E-commerce', 'ecommerce', 'Owner Omar'
  UNION ALL SELECT 'Small Manufacturers and Distributors', 'manufacturers-distributors', 'Ops-Lead Olivia'
  UNION ALL SELECT 'Construction and Renovation Firms', 'construction-renovation', 'Ops-Lead Olivia'
  UNION ALL SELECT 'Management and Business Consulting Firms', 'business-consulting', 'Ops-Lead Olivia'
) t
WHERE w.domain = 'theabdulrehman.com'
  AND NOT EXISTS (SELECT 1 FROM niches n WHERE n.website_id = w.id AND n.slug = t.slug);
