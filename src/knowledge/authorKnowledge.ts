import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AuthorIdentity {
  name: string;
  location: string;
  role: string;
  experience_years: number;
  projects_delivered: number;
  website: string;
  positioning: string;
}

export interface AuthorKnowledgeJson {
  identity: AuthorIdentity;
  core_skills: Record<string, string[]>;
  strength_areas: string[];
  career_highlights: Array<{
    company: string;
    role: string;
    summary: string;
    achievements?: string[];
    tech_stack: string[];
  }>;
  ai_projects: Array<{
    name: string;
    type: string;
    description: string;
    status?: string;
    tech_stack: string[];
  }>;
  target_audience: string[];
  services_offered: string[];
  writing_tone: {
    style: string;
    voice: string;
    avoid: string[];
    focus: string[];
  };
  seo_focus_keywords: string[];
  current_goals: string[];
  conversion_strategy: {
    primary_cta: string;
    secondary_ctas: string[];
    lead_magnet: string;
    positioning: string;
  };
}

export interface AuthorKnowledge {
  raw: string;
  structured?: AuthorKnowledgeJson;
}

const MARKDOWN_PATH = './data/author_knowledge.md';
const JSON_PATH = './data/author_knowledge.json';

export async function loadAuthorKnowledge(): Promise<AuthorKnowledge> {
  const mdPath = path.resolve(process.cwd(), MARKDOWN_PATH);
  const jsonPath = path.resolve(process.cwd(), JSON_PATH);

  // eslint-disable-next-line no-console
  console.log(`[loadAuthorKnowledge] CWD: ${process.cwd()}`);
  // eslint-disable-next-line no-console
  console.log(`[loadAuthorKnowledge] Resolved paths: MD=${mdPath}, JSON=${jsonPath}`);

  // Check if files exist before attempting to read (prevents hanging on missing mounts)
  const mdExists = existsSync(mdPath);
  // eslint-disable-next-line no-console
  console.log(`[loadAuthorKnowledge] MD file exists: ${mdExists}`);
  
  if (!mdExists) {
    throw new Error(
      `Author knowledge file not found: ${mdPath}. ` +
      `Make sure the data/ directory is included in your Docker image or properly mounted.`
    );
  }

  // Load markdown (required) with timeout
  let raw: string;
  try {
    // eslint-disable-next-line no-console
    console.log('[loadAuthorKnowledge] Starting MD file read...');
    const rawPromise = fs.readFile(mdPath, 'utf8');
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout loading markdown knowledge file: ${mdPath}`)), 10000)
    );
    raw = await Promise.race([rawPromise, timeoutPromise]);
    // eslint-disable-next-line no-console
    console.log(`[loadAuthorKnowledge] MD file read complete (${raw.length} chars)`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[loadAuthorKnowledge] Failed to load markdown:', err);
    throw err;
  }

  // Load JSON (optional but recommended)
  let structured: AuthorKnowledgeJson | undefined;
  try {
    if (existsSync(jsonPath)) {
      // eslint-disable-next-line no-console
      console.log('[loadAuthorKnowledge] Starting JSON file read...');
      const jsonContent = await fs.readFile(jsonPath, 'utf8');
      structured = JSON.parse(jsonContent) as AuthorKnowledgeJson;
      // eslint-disable-next-line no-console
      console.log('[loadAuthorKnowledge] JSON file read complete');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[loadAuthorKnowledge] JSON file read failed (optional):', err);
    // JSON file doesn't exist or is invalid - continue without it
  }

  return { raw, structured };
}

/**
 * Format structured knowledge into a prompt-friendly string.
 * Combines both markdown and JSON data for richer context.
 */
export function formatKnowledgeForPrompt(knowledge: AuthorKnowledge): string {
  const sections: string[] = [];

  // Add structured data if available
  if (knowledge.structured) {
    const s = knowledge.structured;

    sections.push(`## Author Profile
- **Name:** ${s.identity.name}
- **Role:** ${s.identity.role}
- **Experience:** ${s.identity.experience_years}+ years, ${s.identity.projects_delivered}+ projects delivered
- **Positioning:** ${s.identity.positioning}`);

    sections.push(`## Core Skills
${Object.entries(s.core_skills)
  .map(([category, skills]) => `- **${category}:** ${skills.join(', ')}`)
  .join('\n')}`);

    sections.push(`## Strength Areas
${s.strength_areas.map((a) => `- ${a}`).join('\n')}`);

    if (s.career_highlights.length > 0) {
      sections.push(`## Career Highlights
${s.career_highlights
  .slice(0, 3)
  .map((h) => `### ${h.company} (${h.role})\n${h.summary}\n**Tech:** ${h.tech_stack.join(', ')}`)
  .join('\n\n')}`);
    }

    if (s.ai_projects.length > 0) {
      sections.push(`## AI Projects
${s.ai_projects.map((p) => `- **${p.name}:** ${p.description}`).join('\n')}`);
    }

    sections.push(`## Writing Guidelines
- **Style:** ${s.writing_tone.style}
- **Voice:** ${s.writing_tone.voice}
- **Focus on:** ${s.writing_tone.focus.join(', ')}
- **Avoid:** ${s.writing_tone.avoid.join(', ')}`);

    sections.push(`## Target Audience
${s.target_audience.join(', ')}`);

    sections.push(`## Services Offered
${s.services_offered.map((svc) => `- ${svc}`).join('\n')}`);

    sections.push(`## SEO Focus Keywords
${s.seo_focus_keywords.join(', ')}`);

    sections.push(`## Conversion Strategy
- **Primary CTA:** ${s.conversion_strategy.primary_cta}
- **Positioning:** ${s.conversion_strategy.positioning}`);
  }

  // Add raw markdown content (includes GitHub repos section)
  sections.push(`## Additional Context (Auto-Generated)\n\n${knowledge.raw}`);

  return sections.join('\n\n');
}
