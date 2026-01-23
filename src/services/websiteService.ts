/**
 * Website configuration types and service
 * Manages multi-website content generation with different voices/tones
 */

import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';

export type VoicePerspective = 'first_person_singular' | 'first_person_plural' | 'third_person';

export interface WebsiteStyleConfig {
  tone: 'conversational' | 'professional' | 'academic';
  formality: 'casual' | 'business_casual' | 'formal';
  includePersonalStories: boolean;
  focusAreas: string[];
  targetAudience: string;
}

export interface Website {
  id: string;
  name: string;
  domain: string;
  voicePerspective: VoicePerspective;
  brandName: string;
  tagline: string | null;
  styleConfig: WebsiteStyleConfig | null;
  defaultCtaText: string | null;
  defaultCtaUrl: string | null;
  isActive: boolean;
}

interface WebsiteRow extends RowDataPacket {
  id: string;
  name: string;
  domain: string;
  voice_perspective: VoicePerspective;
  brand_name: string;
  tagline: string | null;
  style_config: string | WebsiteStyleConfig | null;
  default_cta_text: string | null;
  default_cta_url: string | null;
  is_active: number;
}

export class WebsiteService {
  constructor(private readonly pool: MysqlPool) {}

  /**
   * Get all active websites
   */
  async getActiveWebsites(): Promise<Website[]> {
    const [rows] = await this.pool.query<WebsiteRow[]>(
      `SELECT * FROM websites WHERE is_active = TRUE ORDER BY name`
    );
    return rows.map(this.mapRow);
  }

  /**
   * Get website by ID
   */
  async getById(id: string): Promise<Website | null> {
    const [rows] = await this.pool.query<WebsiteRow[]>(
      `SELECT * FROM websites WHERE id = ?`,
      [id]
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  /**
   * Get website by domain
   */
  async getByDomain(domain: string): Promise<Website | null> {
    const [rows] = await this.pool.query<WebsiteRow[]>(
      `SELECT * FROM websites WHERE domain = ?`,
      [domain]
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  /**
   * Generate voice instructions based on website configuration
   */
  getVoiceInstructions(website: Website): string {
    const perspectiveMap = {
      first_person_singular: {
        pronouns: 'I, me, my, mine',
        example: "In my experience..., What I've found..., I recommend...",
        style: 'personal and direct'
      },
      first_person_plural: {
        pronouns: 'we, us, our, ours',
        example: "At PrimeStrides, we..., Our team has found..., We recommend...",
        style: 'collaborative and professional'
      },
      third_person: {
        pronouns: 'the team, the company, they',
        example: "The team at PrimeStrides..., Industry experts suggest...",
        style: 'formal and authoritative'
      }
    };

    const p = perspectiveMap[website.voicePerspective];
    const style = website.styleConfig;

    return `
WEBSITE-SPECIFIC VOICE RULES FOR ${website.domain}:
═══════════════════════════════════════════════════════════════

Brand: ${website.brandName}
${website.tagline ? `Tagline: ${website.tagline}` : ''}

PERSPECTIVE: Use ${website.voicePerspective.replace(/_/g, ' ')} (${p.pronouns})
Examples: ${p.example}
Style: ${p.style}

${style ? `
TONE: ${style.tone}
FORMALITY: ${style.formality}
${style.includePersonalStories ? 'Include personal anecdotes and "I learned this the hard way" moments.' : 'Focus on actionable advice without personal stories.'}

TARGET AUDIENCE: ${style.targetAudience}
FOCUS AREAS: ${style.focusAreas.join(', ')}
` : ''}

${website.defaultCtaText ? `DEFAULT CTA: "${website.defaultCtaText}"` : ''}
${website.defaultCtaUrl ? `CTA URL: ${website.defaultCtaUrl}` : ''}
`;
  }

  private mapRow(row: WebsiteRow): Website {
    let styleConfig = row.style_config;
    if (typeof styleConfig === 'string') {
      try {
        styleConfig = JSON.parse(styleConfig);
      } catch {
        styleConfig = null;
      }
    }

    return {
      id: row.id,
      name: row.name,
      domain: row.domain,
      voicePerspective: row.voice_perspective,
      brandName: row.brand_name,
      tagline: row.tagline,
      styleConfig: styleConfig as WebsiteStyleConfig | null,
      defaultCtaText: row.default_cta_text,
      defaultCtaUrl: row.default_cta_url,
      isActive: row.is_active === 1
    };
  }
}
