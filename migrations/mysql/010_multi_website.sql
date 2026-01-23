-- Migration: Add multi-website support
-- Allows generating different content variants for different websites

-- Websites configuration table
CREATE TABLE IF NOT EXISTS websites (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  domain VARCHAR(255) NOT NULL UNIQUE,
  
  -- Voice/tone configuration for content generation
  voice_perspective ENUM('first_person_singular', 'first_person_plural', 'third_person') NOT NULL DEFAULT 'first_person_singular',
  -- first_person_singular = "I", "my" (personal blog)
  -- first_person_plural = "we", "our" (agency/company)
  -- third_person = "the team", "PrimeStrides" (formal)
  
  brand_name VARCHAR(100) NOT NULL,
  tagline VARCHAR(255),
  
  -- Content style preferences (JSON for flexibility)
  style_config JSON,
  -- Example: {"tone": "conversational", "formality": "casual", "includePersonalStories": true}
  
  -- CTA configuration
  default_cta_text VARCHAR(255),
  default_cta_url VARCHAR(255),
  
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_domain (domain),
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Insert the two websites
INSERT INTO websites (id, name, domain, voice_perspective, brand_name, tagline, style_config, default_cta_text, default_cta_url) VALUES
(
  UUID(),
  'PrimeStrides Agency',
  'primestrides.com',
  'first_person_plural',
  'PrimeStrides',
  'Building AI-Powered Solutions',
  JSON_OBJECT(
    'tone', 'professional',
    'formality', 'business_casual',
    'includePersonalStories', false,
    'focusAreas', JSON_ARRAY('AI consulting', 'software development', 'team augmentation'),
    'targetAudience', 'CTOs, founders, product leaders'
  ),
  'Ready to accelerate your AI journey? Let''s talk.',
  'https://www.primestrides.com/#contact'
),
(
  UUID(),
  'Abdul Rehman Personal',
  'theabdulrehman.com',
  'first_person_singular',
  'Abdul Rehman',
  'Senior Full-Stack & AI Engineer',
  JSON_OBJECT(
    'tone', 'conversational',
    'formality', 'casual',
    'includePersonalStories', true,
    'focusAreas', JSON_ARRAY('personal insights', 'career advice', 'technical deep-dives'),
    'targetAudience', 'developers, aspiring consultants, tech enthusiasts'
  ),
  'Want to chat about this? Drop me a message.',
  'https://www.theabdulrehman.com/#contact'
) ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Add website_id to posts table (nullable for existing posts)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS website_id VARCHAR(36) AFTER id;

-- Add website_id to topics table (nullable for existing topics)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS website_id VARCHAR(36) AFTER id;
