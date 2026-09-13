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
