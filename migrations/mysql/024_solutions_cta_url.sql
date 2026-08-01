-- Migration: store the CTA destination URL alongside cta_text (023_solutions_cta.sql).
-- Lead capture and tracking happen in an external system (the site's own contact
-- page/form) — this pipeline's job is only to link each solutions page's CTA into
-- it with attribution (UTM params identifying the service x niche), never to
-- capture or store lead data itself. See SolutionsService.buildSolutionCtaUrl().
ALTER TABLE solutions
  ADD COLUMN cta_url VARCHAR(500) NULL AFTER cta_text;
