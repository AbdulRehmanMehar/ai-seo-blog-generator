-- Migration: Change content_markdown to content_json for structured blog posts

-- Add new column for JSON content (nullable initially)
ALTER TABLE posts ADD COLUMN content_json JSON NULL AFTER meta_description;

-- Convert existing markdown posts to a minimal JSON structure
UPDATE posts 
SET content_json = JSON_OBJECT(
  'title', title,
  'slug', slug,
  'meta', JSON_OBJECT('title', meta_title, 'description', meta_description, 'keywords', JSON_ARRAY(primary_keyword)),
  'hero', JSON_OBJECT('hook', SUBSTRING(content_markdown, 1, 500), 'subtitle', ''),
  'sections', JSON_ARRAY(JSON_OBJECT('id', 'migrated-content', 'heading', 'Content', 'level', 2, 'content', content_markdown, 'keyTakeaway', NULL)),
  'faq', JSON_ARRAY(),
  'conclusion', JSON_OBJECT('summary', '', 'cta', JSON_OBJECT('text', '', 'buttonText', 'Learn More', 'action', 'contact')),
  'internalLinks', JSON_ARRAY(),
  'estimatedReadingMinutes', 5
)
WHERE content_json IS NULL AND content_markdown IS NOT NULL;

-- Drop the old markdown column
ALTER TABLE posts DROP COLUMN content_markdown;

-- Make content_json required for new posts
ALTER TABLE posts MODIFY COLUMN content_json JSON NOT NULL;
