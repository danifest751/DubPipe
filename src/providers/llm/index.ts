import type { DubConfig } from '../../config/schema.js';
import { StageError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { KiloGatewayClient } from './gateway.js';
import { OllamaClient } from './ollama.js';
import type { ChatClient } from './types.js';
import { warn, type StageWarning } from '../../core/types.js';

export * from './types.js';
export { KiloGatewayClient, resolveApiKey } from './gateway.js';
export { OllamaClient } from './ollama.js';

export interface ChatClientSelection {
  client: ChatClient;
  warnings: StageWarning[];
  /** True when the configured engine was unreachable and the fallback took over. */
  degraded: boolean;
}

/**
 * Picks the chat provider for a stage, degrading instead of failing (SPEC §15.2):
 * hybrid → gateway, and if the gateway has no key or does not answer, the local
 * model takes over with a warning. Only when nothing is usable is it an error.
 */
export async function selectChatClient(config: DubConfig, model?: string): Promise<ChatClientSelection> {
  const warnings: StageWarning[] = [];

  if (config.translate.engine === 'kilo-gateway') {
    const gateway = await KiloGatewayClient.create(config, model);
    if (!gateway) {
      warnings.push(
        `Ключ ${config.kilo_gateway.api_key_env} не задан — перевод пойдёт локально (ТЗ §15.2)`,
      );
    } else if (await gateway.available()) {
      return { client: gateway, warnings, degraded: false };
    } else {
      warnings.push('Шлюз Kilo недоступен — перевод пойдёт локально (ТЗ §15.2)');
    }

    if (config.translate.fallback_engine === 'none') {
      throw new StageError('s3', 'Шлюз недоступен, а запасной движок отключён', {
        hints: [`Задайте ключ ${config.kilo_gateway.api_key_env} или укажите translate.fallback_engine: ollama`],
      });
    }

    const local = new OllamaClient(config);
    if (await local.available()) {
      log.debug(`переключение на ${local.name} (${local.model})`);
      return { client: local, warnings, degraded: true };
    }

    throw new StageError('s3', 'Ни шлюз, ни локальная модель недоступны — перевод выполнить нечем', {
      hints: [
        `Задайте ключ: переменная ${config.kilo_gateway.api_key_env}`,
        `Либо поднимите Ollama: ollama serve, затем ollama pull ${config.translate.fallback_model}`,
      ],
    });
  }

  const local = new OllamaClient(config, model ?? config.translate.model);
  if (await local.available()) return { client: local, warnings, degraded: false };

  throw new StageError('s3', `Ollama недоступен или модель ${local.model} не установлена`, {
    hints: [
      'Запустите демон: ollama serve',
      `Установите модель: ollama pull ${local.model}`,
      'Либо переключитесь на профиль hybrid и задайте ключ шлюза',
    ],
  });
}
