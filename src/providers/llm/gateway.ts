import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DubConfig } from '../../config/schema.js';
import { log } from '../../core/logger.js';
import { cancellation } from '../../core/cancel.js';
import { withRetry } from '../../util/exec.js';
import { ChatError, type ChatClient, type ChatMessage, type ChatOptions, type ChatResult } from './types.js';

/**
 * OpenAI-compatible chat client for Kilo Gateway (SPEC §3.1).
 *
 * The gateway routes /chat/completions only — it has no speech synthesis and its
 * transcription returns no timestamps — so translation is the single stage that
 * uses it (SPEC §3.1.1).
 */

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; code?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    /** Populated instead of `cost` on BYOK keys, where the gateway charges nothing. */
    market_cost?: number;
    cost_details?: { upstream_inference_cost?: number };
  };
}

/** HTTP statuses worth another attempt: rate limits and transient server faults. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Resolves the token: environment variable first, then the optional file from
 * config. Keeping a token in a file is a convenience for local runs; the value
 * is never logged.
 */
export async function resolveApiKey(config: DubConfig): Promise<string | null> {
  const fromEnv = process.env[config.kilo_gateway.api_key_env];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const file = config.kilo_gateway.api_key_file;
  if (file) {
    const target = path.resolve(process.cwd(), file);
    if (existsSync(target)) {
      const content = (await readFile(target, 'utf8')).trim();
      if (content) return content;
    }
  }
  return null;
}

export class KiloGatewayClient implements ChatClient {
  readonly name = 'Kilo Gateway';
  readonly model: string;

  private constructor(
    private readonly apiKey: string,
    private readonly config: DubConfig,
    model: string,
  ) {
    this.model = model;
  }

  /** Returns null when no token is configured, so the caller can fall back. */
  static async create(config: DubConfig, model?: string): Promise<KiloGatewayClient | null> {
    const apiKey = await resolveApiKey(config);
    if (!apiKey) return null;
    return new KiloGatewayClient(apiKey, config, model ?? config.translate.model);
  }

  private get endpoint(): string {
    return `${this.config.kilo_gateway.endpoint.replace(/\/+$/, '')}/chat/completions`;
  }

  async complete(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.3,
    };
    if (options.maxTokens) body['max_tokens'] = options.maxTokens;
    if (options.json) body['response_format'] = { type: 'json_object' };

    return await withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.kilo_gateway.timeout_ms);
        // Остановка прогона обрывает и сетевой запрос.
        const stop = cancellation.signal;
        const onStop = () => controller.abort();
        stop?.addEventListener('abort', onStop, { once: true });
        try {
          const response = await fetch(this.endpoint, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/dubpipe',
              'X-Title': 'DubPipe',
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const detail = (await response.text()).slice(0, 400);
            throw new ChatError(`Шлюз ответил ${response.status}: ${detail}`, {
              status: response.status,
              retryable: isRetryableStatus(response.status),
            });
          }

          const parsed = (await response.json()) as ChatCompletionResponse;
          if (parsed.error) {
            throw new ChatError(`Ошибка модели: ${parsed.error.message ?? 'без описания'}`);
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) throw new ChatError('Модель вернула пустой ответ', { retryable: true });

          const usage = parsed.usage;
          const cost =
            usage?.cost && usage.cost > 0
              ? usage.cost
              : (usage?.market_cost ?? usage?.cost_details?.upstream_inference_cost);
          return {
            text: content,
            usage: {
              promptTokens: usage?.prompt_tokens ?? 0,
              completionTokens: usage?.completion_tokens ?? 0,
              ...(cost !== undefined ? { cost } : {}),
            },
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new ChatError(
              `Шлюз не ответил за ${Math.round(this.config.kilo_gateway.timeout_ms / 1000)} с`,
              { retryable: true },
            );
          }
          if (error instanceof ChatError) throw error;
          // Network-level failures (DNS, connection reset) are worth retrying.
          throw new ChatError(`Сетевая ошибка: ${(error as Error).message}`, { retryable: true });
        } finally {
          clearTimeout(timer);
          stop?.removeEventListener('abort', onStop);
        }
      },
      {
        attempts: this.config.kilo_gateway.max_retries,
        baseDelayMs: 1000,
        retryable: (error) => error instanceof ChatError && error.retryable,
        onRetry: (attempt, error, delay) =>
          log.debug(`шлюз: попытка ${attempt} не удалась (${(error as Error).message}), пауза ${delay} мс`),
      },
    );
  }

  async available(): Promise<boolean> {
    try {
      await this.complete([{ role: 'user', content: 'ping' }], { maxTokens: 5, temperature: 0 });
      return true;
    } catch (error) {
      log.debug(`шлюз недоступен: ${(error as Error).message}`);
      return false;
    }
  }
}
