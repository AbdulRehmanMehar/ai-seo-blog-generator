import crypto from 'node:crypto';
import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AuthorKnowledge } from '../knowledge/authorKnowledge.js';
import type { GeminiClient } from '../llm/geminiClient.js';
import { topicPlanningPrompt } from '../prompts/topicPlanning.js';
import type { EmbeddingStore } from '../embeddings/embeddingStore.js';
import { WebsiteService, type Website } from './websiteService.js';

export interface TopicPlannerDeps {
  pool: MysqlPool;
  gemini: GeminiClient;
  knowledge: AuthorKnowledge;
  embeddings: EmbeddingStore;
}

const topicPlanSchema = z.object({
  selected: z
    .array(
      z.object({
        keyword: z.string().min(1),
        topic: z.string().min(1),
        outline: z.array(
          z.object({
            heading: z.string().min(1),
            level: z.union([z.literal(2), z.literal(3)]),
            notes: z.string().min(1)
          })
        )
      })
    )
    .min(1)
});

export class TopicPlanner {
  private readonly websiteService: WebsiteService;

  constructor(private readonly deps: TopicPlannerDeps) {
    this.websiteService = new WebsiteService(deps.pool);
  }

  /**
   * Get the next website to assign based on round-robin distribution.
   * Picks the website with the fewest recent posts.
   */
  private async getNextWebsite(): Promise<Website | null> {
    const websites = await this.websiteService.getActiveWebsites();
    if (websites.length === 0) return null;
    if (websites.length === 1) return websites[0]!;

    // Count recent posts per website (last 7 days)
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(`
      SELECT website_id, COUNT(*) as cnt
      FROM posts
      WHERE website_id IS NOT NULL
        AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY website_id
    `);

    const countMap = new Map<string, number>();
    for (const row of rows as any[]) {
      countMap.set(row.website_id, Number(row.cnt));
    }

    // Find website with fewest posts
    let minCount = Infinity;
    let selected = websites[0]!;
    for (const w of websites) {
      const count = countMap.get(w.id) ?? 0;
      if (count < minCount) {
        minCount = count;
        selected = w;
      }
    }

    return selected;
  }

  async planTopics(args: { candidateCount: number; selectCount: number }): Promise<string[]> {
    // Get the target website for this batch
    const targetWebsite = await this.getNextWebsite();
    if (targetWebsite) {
      // eslint-disable-next-line no-console
      console.log(`TopicPlanner: targeting website ${targetWebsite.domain}`);
    }

    // Fetch existing posts for this website to avoid duplicate content angles
    let existingPosts: Array<{ title: string; keyword: string }> = [];
    if (targetWebsite) {
      const [existingRows] = await this.deps.pool.query<RowDataPacket[]>(
        `SELECT title, primary_keyword FROM posts WHERE website_id = ? ORDER BY created_at DESC LIMIT 50`,
        [targetWebsite.id]
      );
      existingPosts = (existingRows as any[]).map(r => ({
        title: String(r.title),
        keyword: String(r.primary_keyword)
      }));
      // eslint-disable-next-line no-console
      console.log(`TopicPlanner: found ${existingPosts.length} existing posts for ${targetWebsite.domain}`);
    }

    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `
      SELECT id, keyword, volume, difficulty, cpc, intent
      FROM keywords
      WHERE status = 'new'
      ORDER BY COALESCE(cpc, 0) DESC, COALESCE(volume, 0) DESC
      LIMIT ?
      `,
      [args.candidateCount]
    );

    const candidates = (rows as any[]).map((r) => ({
      id: String(r.id),
      keyword: String(r.keyword),
      volume: r.volume == null ? null : Number(r.volume),
      difficulty: r.difficulty == null ? null : Number(r.difficulty),
      cpc: r.cpc == null ? null : Number(r.cpc),
      intent: r.intent == null ? null : String(r.intent)
    }));

    if (candidates.length === 0) return [];

    const prompt = topicPlanningPrompt({
      knowledge: this.deps.knowledge,
      candidateKeywords: candidates,
      selectCount: args.selectCount,
      targetWebsite: targetWebsite?.domain,
      existingPosts: existingPosts.length > 0 ? existingPosts : undefined
    });

    const raw = await this.deps.gemini.generateText({
      systemInstruction: prompt.system,
      userPrompt: prompt.user,
      temperature: 0.4,
      maxOutputTokens: 2048
    });

    let plan: z.infer<typeof topicPlanSchema>;
    try {
      const parsedJson = safeJsonParse(raw);
      plan = topicPlanSchema.parse(parsedJson);
    } catch {
      const raw2 = await this.deps.gemini.generateText({
        systemInstruction: prompt.system,
        userPrompt: `${prompt.user}\n\nIMPORTANT:\n- Return ONLY a single JSON object.\n- Do NOT wrap in Markdown fences.\n- No trailing commas, no comments, no extra keys.\n`,
        temperature: 0,
        maxOutputTokens: 2048
      });
      const parsedJson = safeJsonParse(raw2);
      plan = topicPlanSchema.parse(parsedJson);
    }

    const topicIds: string[] = [];

    const candidateByLower = new Map(candidates.map((k) => [k.keyword.toLowerCase(), k] as const));

    for (const item of plan.selected) {
      const keywordRow = candidateByLower.get(item.keyword.toLowerCase());
      if (!keywordRow) {
        // eslint-disable-next-line no-console
        console.log(`TopicPlanner: skipping unknown keyword from model: ${item.keyword}`);
        continue;
      }

      const topicId = crypto.randomUUID();
      await this.deps.pool.query(
        `INSERT INTO topics(id, keyword_id, topic, outline_json, website_id) VALUES (?, ?, ?, ?, ?)`,
        [topicId, keywordRow.id, item.topic, JSON.stringify(item.outline), targetWebsite?.id ?? null]
      );

      await this.deps.pool.query(`UPDATE keywords SET status = 'used' WHERE id = ?`, [keywordRow.id]);

      const embedding = await this.deps.gemini.embedText(`${item.topic}`);
      await this.deps.embeddings.upsert({ entityType: 'topic', entityId: topicId, embedding });
      topicIds.push(topicId);
    }

    // eslint-disable-next-line no-console
    console.log(`TopicPlanner: planned topics=${topicIds.length}`);

    return topicIds;
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

  throw new Error('TopicPlanner: Gemini did not return valid JSON');
}
