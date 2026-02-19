import type { AuthorKnowledge } from '../knowledge/authorKnowledge.js';
import type { GeminiClient } from '../llm/geminiClient.js';
import { humanizePrompt } from '../prompts/humanize.js';
import type { BlogPostStructure } from '../prompts/blogGeneration.js';
import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';

export interface HumanizerDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
  knowledge: AuthorKnowledge;
  minWords: number;
}

export class Humanizer {
  constructor(private readonly deps: HumanizerDeps) {}

  async humanizePost(postId: string): Promise<void> {
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      'SELECT title, content_json, primary_keyword FROM posts WHERE id = ?',
      [postId]
    );
    const row = rows[0] as any;
    if (!row) return;

    // eslint-disable-next-line no-console
    console.log(`   📝 Humanizing: "${row.title}"`);

    // Parse the stored JSON content
    let contentJson: BlogPostStructure;
    try {
      contentJson = typeof row.content_json === 'string' 
        ? JSON.parse(row.content_json) 
        : row.content_json;
    } catch {
      // eslint-disable-next-line no-console
      console.log(`Humanizer: failed to parse content_json for post id=${postId}`);
      return;
    }

    const prompt = humanizePrompt({
      knowledge: this.deps.knowledge,
      keyword: String(row.primary_keyword),
      contentJson
    });

    const rewritten = await this.deps.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.7,
      maxOutputTokens: 8192
    });

    // Parse the humanized JSON response
    let humanizedContent: BlogPostStructure;
    try {
      humanizedContent = safeJsonParse(rewritten) as BlogPostStructure;
    } catch {
      // If parsing fails, try with stricter prompt
      const rewritten2 = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: `${prompt.user}\n\nCRITICAL: Return ONLY valid JSON. Escape newlines as \\n and quotes as \\". No markdown fences.`,
        temperature: 0.3,
        maxOutputTokens: 8192
      });
      humanizedContent = safeJsonParse(rewritten2) as BlogPostStructure;
    }

    // Calculate word count from humanized content
    const allContent = [
      humanizedContent.hero.hook,
      humanizedContent.hero.subtitle,
      ...humanizedContent.sections.map(s => s.content),
      ...humanizedContent.faq.map(f => `${f.question} ${f.answer}`),
      humanizedContent.conclusion.summary,
      humanizedContent.conclusion.cta.text
    ].join(' ');
    
    const wordCount = allContent.split(/\s+/).filter(Boolean).length;
    if (wordCount < this.deps.minWords) {
      // eslint-disable-next-line no-console
      console.log(`   ⚠️  Word count after humanization: ${wordCount} (below min: ${this.deps.minWords})`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`   📝 Word count after humanization: ${wordCount}`);
    }

    await this.deps.pool.query(
      'UPDATE posts SET content_json = ? WHERE id = ?', 
      [JSON.stringify(humanizedContent), postId]
    );
  }
}

function safeJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];

  // Check for markdown fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());

  for (const candidate of candidates) {
    const cleaned = candidate.replace(/^\uFEFF/, '');
    const objStart = cleaned.indexOf('{');
    const objEnd = cleaned.lastIndexOf('}');

    if (objStart >= 0 && objEnd > objStart) {
      const slice = cleaned.slice(objStart, objEnd + 1);
      const withoutTrailingCommas = slice.replace(/,(\s*[}\]])/g, '$1');

      try {
        return JSON.parse(withoutTrailingCommas);
      } catch {
        // try next candidate
      }
    }
  }

  throw new Error('Humanizer: Failed to parse JSON response');
}
