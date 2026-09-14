import { z } from 'zod';

/**
 * Configuration contract (SPEC §5.3) plus execution profiles (SPEC §15).
 * Every constraint here is the one the spec states, so validation messages can
 * quote the allowed range verbatim.
 */

export const PROFILES = ['offline', 'hybrid'] as const;
export type Profile = (typeof PROFILES)[number];

const db = () => z.number().min(-60).max(20);

/**
 * Имя переменной окружения, а не её значение. Сюда по ошибке вставляют сам
 * ключ — и тогда токен попадает в файл настроек и на экран.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const kiloGatewaySchema = z.object({
  api_key_env: z
    .string()
    .min(1)
    .refine((value) => ENV_NAME.test(value), {
      message:
        'здесь должно быть имя переменной окружения (например, KILO_API_KEY), а не сам ключ. ' +
        'Ключ вводится в настройках интерфейса или задаётся переменной окружения',
    })
    .default('KILO_API_KEY'),
  /** Kilo Code exposes an OpenRouter-compatible router; only /chat/completions is routed (SPEC §3.1.1). */
  endpoint: z.string().url().default('https://api.kilocode.ai/api/openrouter'),
  timeout_ms: z.number().int().min(1000).max(600_000).default(120_000),
  max_retries: z.number().int().min(0).max(10).default(3),
  /** Optional file holding the token, used when the env var is unset. */
  api_key_file: z.string().nullable().default(null),
});

const asrSchema = z.object({
  engine: z.enum(['whisper-cpp', 'xenova-whisper', 'kilo-gateway']).default('whisper-cpp'),
  model: z.string().min(1).default('small'),
  /** Пословные таймкоды: `dtw` — выравнивание по вниманию (точное), `heuristic` — по вероятностям токенов (сдвигает первые слова раньше речи). */
  timestamps: z.enum(['dtw', 'heuristic']).default('dtw'),
  device: z.enum(['cpu', 'gpu']).default('cpu'),
  /**
   * Чем считать распознавание: `auto` — официальная сборка под найденное
   * железо, остальное — выбор вручную. `vulkan` задействует видеокарту AMD или
   * Intel, но эту сборку выпускает не сам проект whisper.cpp, поэтому сама она
   * никогда не включается.
   */
  backend: z.enum(['auto', 'cpu', 'blas', 'cuda', 'vulkan']).default('auto'),
  language: z.string().min(2).max(5).default('en'),
  endpoint: z.string().url().nullable().default(null),
  api_key_env: z.string().nullable().default(null),
  threads: z.number().int().min(1).max(64).nullable().default(null),
  vad: z
    .object({
      enabled: z.boolean().default(true),
      /** Boundary snapping window, ±ms around a segment edge (SPEC FR-2). */
      window_ms: z.number().int().min(0).max(2000).default(400),
      model: z.string().min(1).default('ggml-silero-v5.1.2'),
    })
    .default({}),
  diarization: z
    .object({
      enabled: z.boolean().default(true),
      /** `pyannote-onnx` — старое имя того же движка, оставлено ради уже сохранённых конфигов. */
      engine: z.enum(['pyannote', 'pyannote-onnx', 'none']).default('pyannote'),
      model: z.string().min(1).default('pyannote/speaker-diarization-community-1'),
      max_speakers: z.number().int().min(1).max(16).default(4),
      /**
       * Где считать разбор по голосам. Это самый долгий расчёт конвейера — на
       * 35-минутном эпизоде 17 минут против 5 у распознавания, — и видеокарта
       * даёт здесь больше всего.
       *
       * `igpu` и `dgpu` выбирают встроенную или отдельную карту на машинах, где
       * есть обе. `cuda` — то же самое, что `gpu`: имя оставлено потому, что
       * torch показывает через этот интерфейс и ROCm у AMD.
       */
      device: z.enum(['auto', 'cpu', 'gpu', 'igpu', 'dgpu', 'cuda']).default('auto'),
      /** Имя переменной окружения с токеном Hugging Face — никогда не сам токен. */
      hf_token_env: z
        .string()
        // Токен HF (hf_ + 34 символа) сам похож на имя переменной — отсекаем отдельно.
        .refine((value) => ENV_NAME.test(value) && !/^hf_[A-Za-z0-9]{20,}$/.test(value), {
          message:
            'здесь должно быть имя переменной окружения (например, HF_TOKEN), а не сам токен. ' +
            'Токен вводится в настройках интерфейса или задаётся переменной окружения',
        })
        .default('HF_TOKEN'),
    })
    .default({}),
});

const translateSchema = z.object({
  engine: z.enum(['kilo-gateway', 'ollama']).default('kilo-gateway'),
  model: z.string().min(1).default('anthropic/claude-sonnet-4.5'),
  /** Fallback engine used when the primary is unreachable (SPEC §15.2). */
  fallback_engine: z.enum(['ollama', 'none']).default('ollama'),
  fallback_model: z.string().min(1).default('qwen2.5:7b-instruct'),
  ollama_endpoint: z.string().url().default('http://127.0.0.1:11434'),
  batch_size: z.number().int().min(1).max(50).default(10),
  profanity: z.enum(['soft', 'hard', 'keep']).default('soft'),
  /**
   * Speech rate used for length control (SPEC FR-3).
   *
   * Measured on the piper Russian medium voices. The rate is not constant: the
   * same voice runs 9–14 chars/s depending on punctuation and phrase length,
   * because questions and phrase endings get stretched. So this is a ballpark
   * for S3, and S6 is what actually guarantees the fit. S5 records the measured
   * rate in calibration.json after every run.
   */
  chars_per_second: z.number().min(5).max(30).default(11.5),
  /** Share of replicas that must fit the ±15% slot tolerance (SPEC M2). */
  length_tolerance: z.number().min(0).max(1).default(0.15),
  /**
   * Absolute floor for that tolerance. On a 0.7 s slot ±15% is ±1.5 characters,
   * which no language can hit; the floor keeps the target attainable.
   */
  length_tolerance_floor_ms: z.number().int().min(0).max(2000).default(250),
  /** One corrective pass over replicas that missed the length target (SPEC FR-3). */
  fit_length_pass: z.boolean().default(true),
  context_segments: z.number().int().min(0).max(10).default(3),
});

const ttsSchema = z.object({
  engine: z.enum(['piper', 'edge-tts', 'kilo-gateway']).default('piper'),
  model: z.string().nullable().default(null),
  default_voice: z.string().min(1).default('ru_RU-irina-medium'),
  voice_map: z.record(z.string(), z.string()).default({}),
  endpoint: z.string().url().nullable().default(null),
  api_key_env: z.string().nullable().default(null),
  concurrency: z.number().int().min(1).max(8).default(2),
  sample_rate: z.number().int().min(8000).max(48_000).default(48_000),
});

const separationSchema = z.object({
  enabled: z.boolean().default(false),
  engine: z.enum(['mdx-onnx', 'demucs']).default('mdx-onnx'),
  model: z.string().min(1).default('UVR-MDX-NET-Inst_HQ_3'),
  /**
   * Где считать разделение. Сеть тяжёлая, и видеокарта даёт много: на Radeon
   * 780M минута звука обрабатывается за 3 секунды вместо 17. Словарь тот же,
   * что у диаризации; `auto` берёт видеокарту, если onnxruntime её видит.
   */
  device: z.enum(['auto', 'cpu', 'gpu', 'igpu', 'dgpu', 'cuda']).default('auto'),
  fallback_to_ducking: z.boolean().default(true),
});

const alignmentSchema = z.object({
  enabled: z.boolean().default(true),
  min_tempo: z.number().min(0.5).max(1).default(0.9),
  max_tempo: z.number().min(1).max(2).default(1.25),
  max_retranslate: z.number().int().min(0).max(5).default(2),
  gap_ms: z.number().int().min(0).max(2000).default(50),
  max_shift_ms: z.number().int().min(0).max(10_000).default(1500),
  drift_reset_gap_ms: z.number().int().min(0).max(10_000).default(700),
});

const mixSchema = z.object({
  background_gain_db: db().default(-6),
  voice_gain_db: db().default(0),
  loudnorm: z.boolean().default(true),
  loudnorm_target_lufs: z.number().min(-40).max(-5).default(-16),
  /** Applied to the original inside speech windows when S4 is off (SPEC FR-4). */
  duck_db: z.number().min(-60).max(0).default(-18),
  duck_fade_ms: z.number().int().min(0).max(1000).default(120),
});

/** Правила читаемости субтитров (ТЗ FR-8). */
const subtitlesSchema = z.object({
  max_line_chars: z.number().int().min(20).max(80).default(42),
  max_lines: z.number().int().min(1).max(3).default(2),
  min_duration_ms: z.number().int().min(300).max(5000).default(1000),
  max_duration_ms: z.number().int().min(1000).max(15_000).default(7000),
  /** Зазор между соседними титрами: 2 кадра при 24 к/с. */
  gap_ms: z.number().int().min(0).max(500).default(84),
  /** Предел скорости чтения, символов в секунду. */
  max_cps: z.number().min(5).max(30).default(17),
});

const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().min(1).default('.dubpipe'),
});

export const configSchema = z
  .object({
    profile: z.enum(PROFILES).default('hybrid'),
    input: z.string().nullable().default(null),
    output: z.string().nullable().default(null),
    keep_original_track: z.boolean().default(false),
    kilo_gateway: kiloGatewaySchema.default({}),
    asr: asrSchema.default({}),
    translate: translateSchema.default({}),
    tts: ttsSchema.default({}),
    separation: separationSchema.default({}),
    alignment: alignmentSchema.default({}),
    mix: mixSchema.default({}),
    subtitles: subtitlesSchema.default({}),
    cache: cacheSchema.default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.alignment.min_tempo > cfg.alignment.max_tempo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['alignment', 'max_tempo'],
        message: `должно быть не меньше alignment.min_tempo (${cfg.alignment.min_tempo})`,
      });
    }
    // SPEC §3.1.1: the gateway has no speech synthesis at all, so this engine can never work.
    if (cfg.tts.engine === 'kilo-gateway') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tts', 'engine'],
        message:
          'синтез речи через Kilo Gateway не поддерживается: у шлюза нет эндпоинта /audio/speech ' +
          'и нет моделей с аудио на выходе (ТЗ §3.1.1). Используйте "piper" или "edge-tts"',
      });
    }
    // SPEC §3.1.1: the gateway returns no timestamps, so FR-2 cannot be satisfied through it.
    if (cfg.asr.engine === 'kilo-gateway') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['asr', 'engine'],
        message:
          'транскрипция через Kilo Gateway не возвращает таймкоды и не удовлетворяет ТЗ FR-2. ' +
          'Используйте "whisper-cpp" или "xenova-whisper"',
      });
    }
  });

export type DubConfig = z.infer<typeof configSchema>;

/** Provider overrides applied by a profile before user fields win (SPEC §15.1). */
export function profileDefaults(profile: Profile): Partial<{ translate: { engine: 'kilo-gateway' | 'ollama' } }> {
  return profile === 'offline' ? { translate: { engine: 'ollama' } } : { translate: { engine: 'kilo-gateway' } };
}
