import fs from 'node:fs/promises';
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

  // Load markdown (required)
  const raw = await fs.readFile(mdPath, 'utf8');

  // Load JSON (optional but recommended)
  let structured: AuthorKnowledgeJson | undefined;
  try {
    const jsonContent = await fs.readFile(jsonPath, 'utf8');
    structured = JSON.parse(jsonContent) as AuthorKnowledgeJson;
  } catch {
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
