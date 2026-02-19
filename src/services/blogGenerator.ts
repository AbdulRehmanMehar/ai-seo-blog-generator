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
  content: z.string(),
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

  constructor(private readonly deps: BlogGeneratorDeps) {
    this.promptLearner = new PromptLearner(deps.pool);
    this.websiteService = new WebsiteService(deps.pool);
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
    let website: Website | null = null;
    if (effectiveWebsiteId) {
      website = await this.websiteService.getById(effectiveWebsiteId);
      if (website) {
        console.log(`   🌐 Generating for website: ${website.domain}`);
      }
    }

    let outline: unknown = row.outline;
    if (typeof outline === 'string') {
      try {
        outline = JSON.parse(outline);
      } catch {
        // ignore
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

    const prompt = blogGenerationPrompt({
      knowledge: this.deps.knowledge,
      keyword: String(row.keyword),
      topic: String(row.topic),
      outline,
      learnedRules,
      websiteVoice,
      targetIcp
    });

    const raw = await this.deps.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.7,
      maxOutputTokens: 8192
    });

    let blog: BlogPostStructure;
    try {
      const parsedJson = safeJsonParse(raw);
      blog = blogJsonSchema.parse(parsedJson);
    } catch (parseError) {
      // Retry with stricter instructions
      const raw2 = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: `${prompt.user}\n\nPREVIOUS ATTEMPT FAILED TO PARSE. CRITICAL RULES:\n- Return ONLY valid JSON matching the exact schema\n- Escape all newlines in strings as \\n\n- Escape all quotes in strings as \\"\n- No trailing commas\n- No comments`,
        temperature: 0.3,
        maxOutputTokens: 8192
      });
      const parsedJson = safeJsonParse(raw2);
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
      // eslint-disable-next-line no-console
      console.log(`   ⚠️  Word count: ${wordCount} (below min: ${this.deps.minWords})`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`   📝 Word count: ${wordCount}`);
    }

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

    const embedding = await this.deps.gemini.embedText(`${blog.title}\n${blog.meta.description}\n${blog.hero.hook}`);
    await this.deps.embeddings.upsert({ entityType: 'post', entityId: postId, embedding });
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
