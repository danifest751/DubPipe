import type { DubConfig } from '../config/schema.js';
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
): ComputeMap {
  const adapters = hardware.adapters.map(
    (name) => `${name} (${gpuKind(name) === 'integrated' ? 'встроенная' : 'отдельная'})`,
  );
  const onnx = onnxDevice(python.providers);
  const stages: StageCompute[] = [];
  const hints: string[] = [];

  stages.push({
    stage: 'Распознавание речи',
    where: accel.build.title,
    // О происхождении говорим только когда сборка не из официальных релизов:
    // для официальной это шум, для чужой — то, что человек должен знать.
    detail: accel.build.origin.official ? accel.reason : `${accel.reason}; собрана ${accel.build.origin.name}`,
  });
  if (config.asr.backend === 'auto' && (hardware.amd || hardware.intel) && !hardware.nvidia) {
    hints.push('Распознавание можно ускорить вдвое сборкой с Vulkan: asr.backend: vulkan');
  }

  const speakers = config.asr.diarization.enabled && config.asr.diarization.engine !== 'none';
  stages.push({
    stage: 'Разбор по голосам',
    where: !speakers ? 'выключен' : config.asr.diarization.device === 'cpu' ? 'процессор' : onnx.name,
    detail: !speakers
      ? 'все реплики получат один голос'
      : python.available
        ? 'отпечатки голосов на onnxruntime, остальные шаги на процессоре'
        : `нет Python или модулей: ${python.missing.join(', ')}`,
  });
  if (speakers && python.available && !onnx.gpu) {
    hints.push('Разбор по голосам ускоряется вчетверо: pip install onnxruntime-directml');
  }

  stages.push({
    stage: 'Отделение голоса',
    where: !config.separation.enabled
      ? 'выключено'
      : config.separation.device === 'cpu'
        ? 'процессор'
        : onnx.name,
    detail: config.separation.enabled ? 'сеть маски на onnxruntime, спектр на процессоре' : 'оригинал приглушается',
  });

  stages.push({ stage: 'Синтез речи', where: 'процессор', detail: 'piper' });
  stages.push({ stage: 'Укладка и сведение', where: 'процессор', detail: 'ffmpeg; видео копируется без перекодирования' });

  return { adapters, stages, hints };
}

/** Опрашивает систему и собирает карту. */
export async function inspectCompute(config: DubConfig): Promise<ComputeMap> {
  const hardware = await detectHardware();
  const accel = chooseAccel(config.asr.backend, hardware);
  const python = await probePython();
  return describeCompute(config, hardware, accel, python);
}
