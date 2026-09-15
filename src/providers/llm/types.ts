/** Chat-model access shared by S3 (translation) and S6 (shortening). */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object when it supports response formats. */
  json?: boolean;
  /**
   * Схема ответа, если движок умеет её соблюдать.
   *
   * «Верни JSON» и «верни вот такой JSON» — разные требования. Локальные модели
   * первое выполняют, а второе нет: qwen3:4b на настоящем запросе возвращала
   * валидный JSON, в котором просто не было массива items, и стадия отбрасывала
   * все одиннадцать пакетов. С переданной схемой та же модель на том же запросе
   * отвечает правильно. Облачному шлюзу схема не нужна — он и так справляется.
   */
  schema?: Record<string, unknown>;
}

/** Token spend of one call, used for run cost reporting. */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** Cost in USD as reported by the provider, when it reports one. */
  cost?: number;
}

export interface ChatResult {
  text: string;
  usage?: ChatUsage;
}

export interface ChatClient {
  readonly name: string;
  readonly model: string;
  complete(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
  /** Cheap reachability probe used to decide on falling back (SPEC §15.2). */
  available(): Promise<boolean>;
}

export class ChatError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ChatError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
