import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AuthorKnowledge } from '../knowledge/authorKnowledge.js';
import { getIcpByName } from '../knowledge/icpKnowledge.js';
import type { GeminiClient } from '../llm/geminiClient.js';
import { blogGenerationPrompt, type BlogPostStructure } from '../prompts/blogGeneration.js';
import { toSlug } from '../utils/slug.js';
import type { EmbeddingStore } from '../embeddings/embeddingStore.js';
import { PromptLearner } from './promptLearner.js';
import { postHumanizer } from './postHumanizer.js';
import { WebsiteService, type Website } from './websiteService.js';
import { GscFeedbackAggregator } from './gscFeedbackAggregator.js';

export interface BlogGeneratorDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
  knowledge: AuthorKnowledge;
  embeddings: EmbeddingStore;
  minWords: number;
}

// Zod schema matching BlogPostStructure
const sectionSchema = z.object({
  id: z.string(),
  heading: z.string(),
  level: z.union([z.literal(2), z.literal(3)]),
  content: z.string().min(150, 'Section content is too thin — minimum 150 characters'),
  keyTakeaway: z.string().nullable(),
  // Accept string, object, or null for CTA (LLM sometimes returns objects)
  // Transform objects to string (use .text property if available, otherwise stringify)
  cta: z.union([z.string(), z.record(z.any())]).nullable().optional().transform(v => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    // If object, try to extract text or stringify
    if (typeof v === 'object' && v.text) return String(v.text);
    return null;
  })
});

const faqSchema = z.object({
  question: z.string(),
  answer: z.string()
});

const blogJsonSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),
  meta: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    keywords: z.array(z.string())
  }),
  hero: z.object({
    hook: z.string().min(1),
    subtitle: z.string()
  }),
  sections: z.array(sectionSchema).min(1),
  faq: z.array(faqSchema),
  conclusion: z.object({
    summary: z.string(),
    cta: z.object({
      text: z.string(),
      buttonText: z.string(),
      action: z.string()
    })
  }),
  internalLinks: z.array(z.string()),
  estimatedReadingMinutes: z.number()
});

export class BlogGenerator {
  private readonly promptLearner: PromptLearner;
  private readonly websiteService: WebsiteService;
  private readonly gscAggregator: GscFeedbackAggregator;

  constructor(private readonly deps: BlogGeneratorDeps) {
    this.promptLearner = new PromptLearner(deps.pool);
    this.websiteService = new WebsiteService(deps.pool);
    this.gscAggregator = new GscFeedbackAggregator(deps.pool);
  }

  async generateDraftPost(topicId: string, websiteId?: string): Promise<string> {
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `
      SELECT t.id, t.topic, t.outline_json as outline, t.website_id, t.target_icp, k.keyword
      FROM topics t
      JOIN keywords k ON k.id = t.keyword_id
      WHERE t.id = ?
      `,
      [topicId]
    );

    const row = rows[0] as any;
    if (!row) throw new Error('BlogGenerator: topic not found');

    // Determine website - use passed ID, then topic's website_id, then null
    const effectiveWebsiteId = websiteId ?? row.website_id;

    // ── CANNIBALIZATION GUARD (hard, deterministic) ──────────────────────────
    // One published post per keyword per site. A second post targeting the same
    // keyword competes with the first in Google and both lose. If a live post
    // already targets this keyword, refuse to create a competitor — the existing
    // post gets refreshed instead (GSC refresh detectors handle that).
    const [existing] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT slug FROM posts
        WHERE LOWER(TRIM(primary_keyword)) = LOWER(TRIM(?))
          AND status IN ('published', 'draft', 'pending_review')
          ${effectiveWebsiteId ? 'AND website_id = ?' : ''}
        LIMIT 1`,
      effectiveWebsiteId ? [row.keyword, effectiveWebsiteId] : [row.keyword]
    );
    if ((existing as any[]).length > 0) {
      const slug = (existing as any[])[0].slug;
      console.log(`   🛑 Cannibalization guard: "${row.keyword}" already has a live post (/${slug}) — skipping generation, marking keyword used.`);
      await this.deps.pool.query(
        `UPDATE keywords k JOIN topics t ON t.keyword_id = k.id SET k.status = 'used' WHERE t.id = ?`,
        [topicId]
      );
      throw new Error(`Cannibalization guard: keyword "${row.keyword}" already targeted by /${slug}`);
    }
    let website: Website | null = null;
    if (effectiveWebsiteId) {
      website = await this.websiteService.getById(effectiveWebsiteId);
      if (website) {
        console.log(`   🌐 Generating for website: ${website.domain}`);
      }
    }

    let outline: unknown = row.outline;
    let buyerJourneyStage: string | undefined;
    if (typeof outline === 'string') {
      try {
        outline = JSON.parse(outline);
      } catch {
        // ignore
      }
    }
    // Extract buyer_journey_stage if stored as metadata wrapper { buyer_journey_stage, sections }
    if (outline && typeof outline === 'object' && !Array.isArray(outline)) {
      const o = outline as Record<string, unknown>;
      if (o.buyer_journey_stage && Array.isArray(o.sections)) {
        buyerJourneyStage = String(o.buyer_journey_stage);
        outline = o.sections;
        console.log(`   🗺️  Buyer journey stage: ${buyerJourneyStage}`);
      }
    }

    // Fetch learned rules from past review failures
    let learnedRules: string | undefined;
    try {
      learnedRules = await this.promptLearner.generatePromptRules();
      if (learnedRules) {
        console.log('   📚 Including learned rules from past failures');
      }
    } catch (err) {
      console.error('Failed to fetch learned rules:', err);
    }

    // Get website-specific voice instructions
    const websiteVoice = website 
      ? this.websiteService.getVoiceInstructions(website)
      : undefined;

    // Load ICP persona from the topic's target_icp field
    let targetIcp = undefined;
    if (row.target_icp) {
      try {
        targetIcp = await getIcpByName(String(row.target_icp));
        if (targetIcp) {
          console.log(`   🎯 Writing for ICP: "${targetIcp.persona_name}"`);
        }
      } catch (err) {
        console.warn('BlogGenerator: could not load ICP, proceeding without ICP targeting', err);
      }
    }

    // Fetch GSC keyword context (best-effort — non-fatal if no data exists)
    let gscKeywordContext: string | undefined;
    if (website) {
      try {
        const gscCtx = await this.gscAggregator.getKeywordOpportunityContext(
          String(row.keyword),
          website.id
        );
        if (gscCtx) {
          gscKeywordContext = this.gscAggregator.formatKeywordContextForPrompt(
            String(row.keyword),
            gscCtx
          );
          console.log(`   📡 GSC keyword context injected for "${row.keyword}"`);
        }
      } catch { /* non-fatal: GSC data may not exist yet */ }
    }

    const prompt = blogGenerationPrompt({
      knowledge: this.deps.knowledge,
      keyword: String(row.keyword),
      topic: String(row.topic),
      outline,
      learnedRules,
      websiteVoice,
      targetIcp,
      gscKeywordContext,
      buyerJourneyStage
    });

    const raw = await this.deps.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.7,
      maxOutputTokens: 8192
    });

    // Repair mechanical omissions before validation — cheap models sometimes
    // drop derivable fields (empty internalLinks, reading time, hero wrapper)
    // even when the substantive content is complete.
    const repairShape = (p: any): any => {
      if (!p || typeof p !== 'object') return p;
      if (!Array.isArray(p.internalLinks)) p.internalLinks = [];
      if (typeof p.estimatedReadingMinutes !== 'number' && Array.isArray(p.sections)) {
        const words = p.sections.reduce((n: number, s: any) => n + String(s?.content ?? '').split(/\s+/).length, 0);
        p.estimatedReadingMinutes = Math.max(3, Math.round(words / 200));
      }
      if ((!p.hero || typeof p.hero.hook !== 'string') && (typeof p.hook === 'string' || typeof p.subtitle === 'string')) {
        p.hero = { hook: String(p.hook ?? ''), subtitle: String(p.subtitle ?? '') };
      }
      return p;
    };

    let blog: BlogPostStructure;
    try {
      const parsedJson = repairShape(safeJsonParse(raw));
      blog = blogJsonSchema.parse(parsedJson);
    } catch (parseError) {
      // Retry with stricter instructions
      const raw2 = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: `${prompt.user}\n\nPREVIOUS ATTEMPT FAILED TO PARSE. CRITICAL RULES:\n- Return ONLY valid JSON matching the exact schema\n- Escape all newlines in strings as \\n\n- Escape all quotes in strings as \\"\n- No trailing commas\n- No comments`,
        temperature: 0.3,
        maxOutputTokens: 8192
      });
      const parsedJson = repairShape(safeJsonParse(raw2));
      blog = blogJsonSchema.parse(parsedJson);
    }

    // Post-processing: Humanize the content to clean AI patterns
    // This is a SEPARATE pass to reduce cognitive load on the generation model
    const { post: humanizedBlog, changes } = postHumanizer.humanize(blog);
    blog = humanizedBlog;
    if (changes.length > 0) {
      console.log(`   🧹 Post-humanization: ${changes.join(', ')}`);
    }

    const finalSlug = toSlug(blog.slug || blog.title);

    // Calculate word count from all content fields
    const allContent = [
      blog.hero.hook,
      blog.hero.subtitle,
      ...blog.sections.map(s => s.content),
      ...blog.faq.map(f => `${f.question} ${f.answer}`),
      blog.conclusion.summary,
      blog.conclusion.cta.text
    ].join(' ');
    
    const wordCount = allContent.split(/\s+/).filter(Boolean).length;
    if (wordCount < this.deps.minWords) {
      throw new Error(
        `Thin content rejected: ${wordCount} words (minimum is ${this.deps.minWords}). ` +
        `Sections averaged ${Math.round(wordCount / blog.sections.length)} words each — ` +
        `Google will not index posts below this threshold.`
      );
    }
    // eslint-disable-next-line no-console
    console.log(`   📝 Word count: ${wordCount}`);

    const postId = crypto.randomUUID();
    
    // Store as structured JSON instead of markdown
    await this.deps.pool.query(
      `
      INSERT INTO posts(
        id, website_id, topic_id, title, slug, primary_keyword, meta_title, meta_description, content_json, target_icp, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
      `,
      [
        postId,
        website?.id ?? null,
        topicId, 
        blog.title, 
        finalSlug, 
        String(row.keyword), 
        blog.meta.title, 
        blog.meta.description, 
        JSON.stringify(blog),
        targetIcp?.persona_name ?? null
      ]
    );

    // Embedding is best-effort: it powers related-links/dedup, but its failure
    // (e.g., the vector DB being unreachable) must never kill a finished post.
    try {
      const embedding = await this.deps.gemini.embedText(`${blog.title}\n${blog.meta.description}\n${blog.hero.hook}`);
      await this.deps.embeddings.upsert({ entityType: 'post', entityId: postId, embedding });
    } catch (err) {
      console.log(`   ⚠️ Embedding skipped (non-fatal): ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
    }
    return postId;
  }
}

function safeJsonParse(raw: string): unknown {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());

  for (const candidate of candidates) {
    const cleaned = candidate.replace(/^\uFEFF/, '');
    const objStart = cleaned.indexOf('{');
    const objEnd = cleaned.lastIndexOf('}');
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');

    let slice = cleaned;
    const hasObj = objStart >= 0 && objEnd > objStart;
    const hasArr = arrStart >= 0 && arrEnd > arrStart;
    if (hasObj || hasArr) {
      if (hasArr && (!hasObj || arrEnd - arrStart > objEnd - objStart)) {
        slice = cleaned.slice(arrStart, arrEnd + 1);
      } else if (hasObj) {
        slice = cleaned.slice(objStart, objEnd + 1);
      }
    }

    const withoutTrailingCommas = slice.replace(/,(\s*[}\]])/g, '$1');

    try {
      return JSON.parse(withoutTrailingCommas);
    } catch {
      // try next candidate
    }
  }

  throw new Error('BlogGenerator: Gemini did not return valid JSON');
}
