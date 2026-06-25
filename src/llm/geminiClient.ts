import { sleep } from '../utils/sleep.js';
import { withRetry } from '../utils/retry.js';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import type { GeminiRateLimiter, ModelType } from './rateLimiter.js';

export interface GeminiClientOptions {
  rateLimiter: GeminiRateLimiter;
  generationModel: string;
  embeddingModel: string;
  minSecondsBetweenRequests: number;
}

interface GenerateTextInput {
  systemInstruction?: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export class GeminiClient {
  private readonly rateLimiter: GeminiRateLimiter;
  private readonly generationModel: string;
  private readonly embeddingModel: string;
  private readonly minMsBetween: number;

  // Cache GoogleGenAI instances per API key
  private readonly aiInstances = new Map<string, GoogleGenAI>();

  private lastRequestAt = 0;

  // When true, text generation is served by OpenRouter (e.g. DeepSeek) instead of Gemini.
  // Embeddings always stay on Gemini regardless.
  private readonly useOpenRouter: boolean;

  constructor(opts: GeminiClientOptions) {
    this.rateLimiter = opts.rateLimiter;
    this.generationModel = opts.generationModel;
    this.embeddingModel = opts.embeddingModel;
    this.minMsBetween = opts.minSecondsBetweenRequests * 1000;
    this.useOpenRouter = env.LLM_PROVIDER === 'openrouter' && !!env.OPENROUTER_API_KEY;
  }

  /**
   * Generate text via OpenRouter (OpenAI-compatible chat completions). Used for the whole
   * generation workload when LLM_PROVIDER=openrouter — bypasses the Gemini rate limiter /
   * free-tier daily cap. The 12 services call generateText() unchanged.
   */
  private async generateViaOpenRouter(input: GenerateTextInput): Promise<string> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (input.systemInstruction) messages.push({ role: 'system', content: input.systemInstruction });
    messages.push({ role: 'user', content: input.userPrompt });

    return withRetry(
      async () => {
        const res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'content-type': 'application/json',
            'X-Title': 'ai-seo-blog-generator',
          },
          body: JSON.stringify({
            model: env.OPENROUTER_MODEL,
            messages,
            temperature: input.temperature ?? 0.7,
            max_tokens: input.maxOutputTokens ?? 8192,
            // Every generateText caller in this codebase expects a JSON object; forcing
            // JSON mode eliminates the truncated/unescaped-string parse failures.
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(120_000),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`) as Error & { status?: number };
          err.status = res.status;
          throw err;
        }

        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content;
        if (!content || typeof content !== 'string' || !content.trim()) {
          throw new Error('OpenRouter: empty response content');
        }
        return content.trim();
      },
      { retries: 3, baseDelayMs: 1500, maxDelayMs: 15000 }
    );
  }

  /**
   * Get or create a GoogleGenAI instance for an API key
   */
  private getAiInstance(apiKey: string): GoogleGenAI {
    let instance = this.aiInstances.get(apiKey);
    if (!instance) {
      instance = new GoogleGenAI({ apiKey });
      this.aiInstances.set(apiKey, instance);
    }
    return instance;
  }

  /**
   * Enforce minimum delay between requests
   */
  private async enforceMinDelay() {
    const now = Date.now();
    const wait = Math.max(0, this.minMsBetween - (now - this.lastRequestAt));
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /**
   * Select the best available key with rate limit awareness
   */
  private async selectKeyForModel(modelName: string, modelType: ModelType, estimatedTokens = 0) {
    const keyInfo = await this.rateLimiter.waitForAvailableKey(
      modelName,
      modelType,
      estimatedTokens,
      120000 // Max 2 min wait
    );
    return keyInfo;
  }

  private shouldDisableKeyOnError(err: any): { disable: boolean; reason: string } {
    const status = err?.status;
    const msg = String(err?.message ?? '');
    // Typical revoked/blocked cases:
    // - 403 PERMISSION_DENIED (project denied / key revoked)
    // - 401 UNAUTHENTICATED (invalid key)
    if (status === 403 && msg.includes('PERMISSION_DENIED')) return { disable: true, reason: 'permission_denied' };
    if (status === 401) return { disable: true, reason: 'unauthenticated' };
    if (status === 403) return { disable: true, reason: 'forbidden' };
    return { disable: false, reason: '' };
  }

  async generateText(input: GenerateTextInput): Promise<string> {
    // Generation provider switch — embeddings stay on Gemini (see embedText).
    if (this.useOpenRouter) {
      return this.generateViaOpenRouter(input);
    }

    const effectiveUserPrompt = input.systemInstruction
      ? `${input.systemInstruction}\n\n${input.userPrompt}`
      : input.userPrompt;

    const temperature = input.temperature ?? 0.7;
    
    // Estimate tokens (rough: 4 chars per token)
    const estimatedInputTokens = Math.ceil(effectiveUserPrompt.length / 4);

    const response = await withRetry(
      async () => {
        await this.enforceMinDelay();

        // Select best key with rate limit awareness
        const keyInfo = await this.selectKeyForModel(
          this.generationModel,
          'generation',
          estimatedInputTokens
        );
        const ai = this.getAiInstance(keyInfo.apiKey);

        try {
          const result = await ai.models.generateContent({
            model: this.generationModel,
            contents: effectiveUserPrompt,
            config: {
              temperature,
              maxOutputTokens: 65536
            }
          } as any);

          // Get actual token count from response if available
          const usageMetadata = (result as any)?.usageMetadata;
          const totalTokens = usageMetadata?.totalTokenCount ?? estimatedInputTokens;

          // Record usage with actual token count
          await this.rateLimiter.recordUsage(keyInfo.apiKey, 'generation', totalTokens);

          return result;
        } catch (error: any) {
          const maybe = this.shouldDisableKeyOnError(error);
          if (maybe.disable) {
            this.rateLimiter.disableKey(keyInfo.apiKey, { reason: maybe.reason });
            // eslint-disable-next-line no-console
            console.warn(`[GeminiClient] Disabled API key [${keyInfo.apiKey.slice(0, 10)}...] ${keyInfo.keyHash} (${maybe.reason}) after ${error?.status ?? 'err'}`);
          }
          // Still record on rate limit errors (request was attempted)
          if (error?.status === 429) {
            await this.rateLimiter.recordUsage(keyInfo.apiKey, 'generation', estimatedInputTokens);
          }
          throw error;
        }
      },
      { retries: 3, baseDelayMs: 1000, maxDelayMs: 10000 }
    );

    const text = String((response as any)?.text ?? '').trim();
    if (!text) {
      throw new Error('GeminiClient: empty response text from generateContent');
    }
    return text;
  }

  async embedText(text: string): Promise<number[]> {
    // Estimate tokens for embedding
    const estimatedTokens = Math.ceil(text.length / 4);

    const response = await withRetry(
      async () => {
        await this.enforceMinDelay();

        // Select best key with rate limit awareness (embeddings have different limits)
        const keyInfo = await this.selectKeyForModel(
          this.embeddingModel,
          'embedding',
          estimatedTokens
        );
        const ai = this.getAiInstance(keyInfo.apiKey);

        try {
          const result = await ai.models.embedContent({
            model: this.embeddingModel,
            contents: [text],
            config: {
              outputDimensionality: 768 // Match pgvector column dimension
            }
          });

          // Record usage AFTER successful request
          await this.rateLimiter.recordUsage(keyInfo.apiKey, 'embedding', estimatedTokens);

          return result;
        } catch (error: any) {
          const maybe = this.shouldDisableKeyOnError(error);
          if (maybe.disable) {
            this.rateLimiter.disableKey(keyInfo.apiKey, { reason: maybe.reason });
            // eslint-disable-next-line no-console
            console.warn(`[GeminiClient] Disabled API key [${keyInfo.apiKey.slice(0, 10)}...] ${keyInfo.keyHash} (${maybe.reason}) after ${error?.status ?? 'err'}`);
          }
          if (error?.status === 429) {
            await this.rateLimiter.recordUsage(keyInfo.apiKey, 'embedding', estimatedTokens);
          }
          throw error;
        }
      },
      { retries: 3, baseDelayMs: 1000, maxDelayMs: 10000 }
    );

    const embeddings = (response as any)?.embeddings;
    const values = embeddings?.[0]?.values as number[] | undefined;
    if (!values || values.length === 0) {
      throw new Error('GeminiClient: embedContent returned empty embedding');
    }
    return values;
  }

  /**
   * Get usage summary for logging
   */
  async getUsageSummary(): Promise<string> {
    return this.rateLimiter.getUsageSummary();
  }

  /**
   * Get the rate limiter for direct access if needed
   */
  get limiter(): GeminiRateLimiter {
    return this.rateLimiter;
  }
}
