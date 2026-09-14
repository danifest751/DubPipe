import path from 'node:path';
import type { DubConfig } from '../config/schema.js';
import type { Workspace } from './workspace.js';

/**
 * Темп речи синтезатора: сколько знаков он выговаривает за секунду.
 *
 * От этого числа зависит, какой длины перевод заказывать: слишком длинный
 * придётся ускорять или переписывать короче, слишком короткий оставит паузу.
 * Настройка — лишь первое приближение, потому что темп зависит от голоса: на
 * ru_RU-irina-medium замер дал 13.22 знака в секунду против 11.5 из настроек,
 * то есть в слот помещалось на 15% больше текста, чем у неё просили.
 *
 * Поэтому темп измеряется на каждом прогоне и запоминается: для этой записи —
 * рядом с её артефактами, а для голоса вообще — в общем файле, чтобы первый же
 * прогон нового видео целился правильно.
 */
export interface Calibration {
  chars_per_second: number;
  voice: string;
  measured_at: string;
  samples: number;
}

const GLOBAL_FILE = 'calibration.json';

/** Осмысленный ли это замер: 5–30 знаков в секунду — границы человеческой речи. */
export function usableRate(rate: number | undefined | null): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 5 && rate <= 30;
}

/**
 * Темп для расчётов: замер этой записи, затем запомненный для этого голоса,
 * затем настройка.
 *
 * Замер чужого голоса не годится: у каждого свой темп, и подставить его —
 * значит промахнуться увереннее, чем с настройкой по умолчанию.
 */
export async function effectiveCharsPerSecond(workspace: Workspace, config: DubConfig): Promise<number> {
  const voice = config.tts.default_voice;
  const local = await workspace.readJson<Partial<Calibration>>(workspace.file(GLOBAL_FILE));
  if (usableRate(local?.chars_per_second) && (!local?.voice || local.voice === voice)) {
    return local.chars_per_second;
  }

  const shared = await workspace.readJson<Record<string, Partial<Calibration>>>(
    path.join(workspace.root, GLOBAL_FILE),
  );
  const remembered = shared?.[voice]?.chars_per_second;
  return usableRate(remembered) ? remembered : config.translate.chars_per_second;
}

/** Запоминает замер: и для этой записи, и для голоса вообще. */
export async function rememberCalibration(workspace: Workspace, calibration: Calibration): Promise<void> {
  await workspace.writeJson(workspace.file(GLOBAL_FILE), calibration);
  const sharedPath = path.join(workspace.root, GLOBAL_FILE);
  const shared = (await workspace.readJson<Record<string, Calibration>>(sharedPath)) ?? {};
  shared[calibration.voice] = calibration;
  await workspace.writeJson(sharedPath, shared);
}
