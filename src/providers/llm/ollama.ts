import type { DubConfig } from '../../config/schema.js';
import { log } from '../../core/logger.js';
import { cancellation } from '../../core/cancel.js';
import { withRetry } from '../../util/exec.js';
import { ChatError, type ChatClient, type ChatMessage, type ChatOptions, type ChatResult } from './types.js';

/**
 * Local LLM through Ollama — the offline translation path (SPEC §3.3, §15.1).
 * Same interface as the gateway client, so S3 does not care which one it got.
 */

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

export class OllamaClient implements ChatClient {
  readonly name = 'Ollama (локально)';
  readonly model: string;

  constructor(
    private readonly config: DubConfig,
    model?: string,
  ) {
    this.model = model ?? config.translate.fallback_model;
  }

  private get base(): string {
    return this.config.translate.ollama_endpoint.replace(/\/+$/, '');
  }

  async complete(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: { temperature: options.temperature ?? 0.3 },
    };
    if (options.json) body['format'] = 'json';

    return await withRetry(
      async () => {
        const controller = new AbortController();
        // Local generation on CPU is slow; allow it far more time than the gateway.
        const timeoutMs = Math.max(this.config.kilo_gateway.timeout_ms, 600_000);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Остановка прогона обрывает и сетевой запрос.
        const stop = cancellation.signal;
        const onStop = () => controller.abort();
        stop?.addEventListener('abort', onStop, { once: true });
        try {
          const response = await fetch(`${this.base}/api/chat`, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new ChatError(`Ollama ответил ${response.status}: ${detail}`, {
              status: response.status,
              retryable: response.status >= 500,
            });
          }
          const parsed = (await response.json()) as OllamaChatResponse;
          if (parsed.error) throw new ChatError(`Ollama: ${parsed.error}`);
          const content = parsed.message?.content;
          if (!content) throw new ChatError('Ollama вернул пустой ответ', { retryable: true });
          return {
            text: content,
            // Local generation is free; tokens are still reported for the run log.
            usage: {
              promptTokens: parsed.prompt_eval_count ?? 0,
              completionTokens: parsed.eval_count ?? 0,
              cost: 0,
            },
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new ChatError('Ollama не ответил вовремя', { retryable: true });
          }
          if (error instanceof ChatError) throw error;
          throw new ChatError(`Не удалось обратиться к Ollama: ${(error as Error).message}`, {
            retryable: true,
          });
        } finally {
          clearTimeout(timer);
          stop?.removeEventListener('abort', onStop);
        }
      },
      { attempts: 2, baseDelayMs: 1000, retryable: (error) => error instanceof ChatError && error.retryable },
    );
  }

  /** Checks both that the daemon answers and that the model is actually pulled. */
  async available(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.base}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return false;

      const parsed = (await response.json()) as OllamaTagsResponse;
      const names = (parsed.models ?? []).map((m) => m.name ?? '');
      const installed = names.some((name) => name === this.model || name.split(':')[0] === this.model.split(':')[0]);
      if (!installed) {
        log.debug(`Ollama запущен, но модель ${this.model} не установлена (есть: ${names.join(', ') || 'нет моделей'})`);
        return false;
      }
      return true;
    } catch (error) {
      log.debug(`Ollama недоступен: ${(error as Error).message}`);
      return false;
    }
  }
}
