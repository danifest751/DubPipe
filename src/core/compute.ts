import type { DubConfig } from '../config/schema.js';
import { onServer, serverEnabled, workerHealth, type ServerStage, type WorkerHealth } from '../providers/remote/server.js';
import { probePython, type PythonEnvironment } from '../stages/s4-separate.js';
import {
  chooseAccel,
  detectHardware,
  gpuKind,
  type AccelChoice,
  type Hardware,
} from '../providers/asr/accel.js';

/**
 * Что где считается.
 *
 * Ответ на этот вопрос был рассыпан по журналам прогонов: сборка распознавания
 * выбирается в одном месте, исполнитель onnxruntime — в другом, на стороне
 * Python, а увидеть их вместе было негде. `doctor` печатает эту карту.
 *
 * Устройство выбирается стадиями по отдельности намеренно: выгода у них разная.
 * На Radeon 780M одна и та же видеокарта ускоряет сеть отпечатков впятеро, а
 * сеть сегментации замедляет вдесятеро — она крошечная, и пересылка данных
 * стоит дороже вычислений.
 */
export interface StageCompute {
  /** Имя стадии так, как его видит человек. */
  stage: string;
  /** Где считается: короткая строка для списка. */
  where: string;
  /** Уточнение: чем именно, или почему не на видеокарте. */
  detail?: string;
}

export interface ComputeMap {
  adapters: string[];
  /** Сервер с видеокартой, если он задан: адрес и что о нём известно. */
  server?: { host: string; online: boolean; gpu: string | null };
  stages: StageCompute[];
  /** Советы: что можно включить и чего для этого не хватает. */
  hints: string[];
}

/** Исполнитель onnxruntime, который возьмут стадии на Python. */
export function onnxDevice(providers: string[]): { name: string; gpu: boolean } {
  for (const [provider, name] of [
    ['DmlExecutionProvider', 'видеокарта (DirectML)'],
    ['CUDAExecutionProvider', 'видеокарта (CUDA)'],
    ['ROCMExecutionProvider', 'видеокарта (ROCm)'],
  ] as const) {
    if (providers.includes(provider)) return { name, gpu: true };
  }
  return { name: 'процессор', gpu: false };
}

/**
 * Собирает карту из уже добытых сведений. Отделена от опроса системы, чтобы
 * её можно было проверить тестами, не заводя ни видеокарты, ни Python.
 */
export function describeCompute(
  config: DubConfig,
  hardware: Hardware,
  accel: AccelChoice,
  python: PythonEnvironment,
  health: WorkerHealth | null = null,
): ComputeMap {
  const adapters = hardware.adapters.map(
    (name) => `${name} (${gpuKind(name) === 'integrated' ? 'встроенная' : 'отдельная'})`,
  );
  const onnx = onnxDevice(python.providers);
  const stages: StageCompute[] = [];
  const hints: string[] = [];

  /*
   * Стадия, отданная серверу. Сервер ответил и умеет её — считается там;
   * нет — строка говорит, куда она откатится, а ниже её описывает локальный
   * путь, как если бы сервера не было.
   */
  const gpu = health?.gpu?.name ?? null;
  const remote = (stage: ServerStage, capability: keyof WorkerHealth['capabilities'], name: string, detail: string): boolean => {
    if (!onServer(config, stage)) return false;
    if (health?.capabilities[capability]) {
      stages.push({ stage: name, where: `сервер ${config.server.host}${gpu ? ` (${gpu})` : ''}`, detail });
      return true;
    }
    hints.push(
      health === null
        ? `${name}: сервер ${config.server.host} не отвечает — считается на этом компьютере`
        : `${name}: на сервере не установлено нужное — считается на этом компьютере`,
    );
    return false;
  };

  if (remote('asr', 'asr', 'Распознавание речи', `faster-whisper ${config.asr.model}, CUDA`)) {
    // на сервере
  } else stages.push({
    stage: 'Распознавание речи',
    where: accel.build.title,
    // О происхождении говорим только когда сборка не из официальных релизов:
    // для официальной это шум, для чужой — то, что человек должен знать.
    detail: accel.build.origin.official ? accel.reason : `${accel.reason}; собрана ${accel.build.origin.name}`,
  });
  if (!onServer(config, 'asr') && config.asr.backend === 'auto' && (hardware.amd || hardware.intel) && !hardware.nvidia) {
    hints.push('Распознавание можно ускорить вдвое сборкой с Vulkan: asr.backend: vulkan');
  }

  const speakers = config.asr.diarization.enabled && config.asr.diarization.engine !== 'none';
  if (!(speakers && remote('diarization', 'diarization', 'Разбор по голосам', 'pyannote, CUDA'))) stages.push({
    stage: 'Разбор по голосам',
    where: !speakers ? 'выключен' : config.asr.diarization.device === 'cpu' ? 'процессор' : onnx.name,
    detail: !speakers
      ? 'все реплики получат один голос'
      : python.available
        ? 'отпечатки голосов на onnxruntime, остальные шаги на процессоре'
        : `нет Python или модулей: ${python.missing.join(', ')}`,
  });
  if (speakers && !onServer(config, 'diarization') && python.available && !onnx.gpu) {
    hints.push('Разбор по голосам ускоряется вчетверо: pip install onnxruntime-directml');
  }

  if (!(config.separation.enabled && remote('separation', 'separation', 'Отделение голоса', 'MDX-Net, onnxruntime CUDA'))) stages.push({
    stage: 'Отделение голоса',
    where: !config.separation.enabled
      ? 'выключено'
      : config.separation.device === 'cpu'
        ? 'процессор'
        : onnx.name,
    detail: config.separation.enabled ? 'сеть маски на onnxruntime, спектр на процессоре' : 'оригинал приглушается',
  });

  if (!(config.tts.engine === 'silero' && remote('tts', 'tts', 'Синтез речи', 'silero, CUDA'))) {
    stages.push({ stage: 'Синтез речи', where: 'процессор', detail: config.tts.engine });
  }
  if (config.tts.clone.enabled) {
    if (!remote('clone', 'clone', 'Голоса актёров', 'X-Voice, образец с отделённой дорожки голоса')) {
      stages.push({
        stage: 'Голоса актёров',
        where: 'выключены',
        detail: onServer(config, 'clone') ? 'сервер не отвечает или X-Voice на нём не установлен' : 'нужен сервер с видеокартой',
      });
    }
  }
  // Ollama — отдельная служба сервера: dubpipe-worker за неё не отвечает, и его
  // молчание о ней ничего не говорит. Облачный перевод от сервера не зависит.
  if (onServer(config, 'translate')) {
    stages.push({ stage: 'Перевод (локальный)', where: `Ollama на ${config.server.host}`, detail: config.translate.fallback_model });
  }
  stages.push({ stage: 'Укладка и сведение', where: 'процессор', detail: 'ffmpeg; видео копируется без перекодирования' });

  const server = serverEnabled(config) ? { host: config.server.host!, online: health !== null, gpu } : undefined;
  return { adapters, stages, hints, ...(server ? { server } : {}) };
}

/**
 * Вариант выбора устройства для настроек.
 *
 * У варианта либо своё имя — тогда это настоящее устройство, найденное в
 * системе, — либо ключ словаря, если имени у него быть не может («как решит
 * программа», «процессор»).
 */
export interface DeviceOption {
  value: string;
  /** Имя устройства так, как его сообщает система. */
  name?: string;
  /** Ключ словаря интерфейса для вариантов без собственного имени. */
  key?: string;
}

export interface DeviceOptions {
  /** Сборка whisper.cpp — `asr.backend`. */
  backend: DeviceOption[];
  /** Исполнитель стадий на Python — `asr.diarization.device`, `separation.device`. */
  device: DeviceOption[];
}

/**
 * Что вообще можно выбрать на этой машине.
 *
 * Список составляется по найденному железу, а не по всем мыслимым вариантам:
 * «видеокарта», «встроенная видеокарта» и «отдельная видеокарта» в списке на
 * машине с одной встроенной Radeon — это три способа сказать одно и то же и ни
 * одного способа понять, что выберется. Поэтому здесь каждое устройство названо
 * своим именем, а того, чего в системе нет, в списке не появляется.
 */
export function deviceOptions(hardware: Hardware): DeviceOptions {
  const backend: DeviceOption[] = [
    { value: 'auto', key: 'settings.backend.auto' },
    { value: 'blas', key: 'settings.backend.blas' },
    { value: 'cpu', key: 'settings.backend.cpu' },
  ];
  const device: DeviceOption[] = [
    { value: 'auto', key: 'settings.device.auto' },
    { value: 'cpu', key: 'settings.device.cpu' },
  ];

  // Первая карта каждого вида: два адаптера одного вида всё равно неразличимы
  // для onnxruntime — он берёт тот, что видит первым.
  const seen = new Set<string>();
  for (const name of hardware.adapters) {
    const value = gpuKind(name) === 'integrated' ? 'igpu' : 'dgpu';
    if (seen.has(value)) continue;
    seen.add(value);
    device.push({ value, name });
  }

  // CUDA — только при видеокарте NVIDIA: на остальных этот выбор означал бы
  // молчаливый откат на процессор.
  if (hardware.nvidia) {
    backend.push({ value: 'cuda', name: `${hardware.adapters.find((name) => /nvidia|geforce|rtx|gtx/i.test(name)) ?? 'NVIDIA'} (CUDA)` });
    device.push({ value: 'cuda', name: `${hardware.adapters.find((name) => /nvidia|geforce|rtx|gtx/i.test(name)) ?? 'NVIDIA'} (CUDA)` });
  }

  // Сборка с Vulkan есть только под AMD и Intel, и выпускает её не сам проект.
  if (hardware.amd || hardware.intel) {
    const adapter = hardware.adapters.find((name) => /amd|radeon|intel|arc|iris|uhd/i.test(name));
    backend.push({ value: 'vulkan', name: `${adapter ?? 'AMD / Intel'} (Vulkan)` });
  }

  return { backend, device };
}

/** Опрашивает систему и собирает карту. */
export async function inspectCompute(config: DubConfig): Promise<ComputeMap> {
  const hardware = await detectHardware();
  const accel = chooseAccel(config.asr.backend, hardware);
  const python = await probePython();
  const health = await workerHealth(config, 0);
  return describeCompute(config, hardware, accel, python, health);
}
