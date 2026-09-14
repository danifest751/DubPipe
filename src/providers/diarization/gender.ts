import { open } from 'node:fs/promises';

/**
 * Пол голоса спикера по основному тону (F0) оригинальной речи.
 *
 * Нужен для одного: чтобы мужчине не доставался женский голос по умолчанию.
 * Это не диаризация (её по признакам сигнала ТЗ запрещает) — говорящие уже
 * разделены pyannote; здесь лишь измеряется высота уже известного голоса.
 * Основной тон ищется алгоритмом YIN на кадрах внутри ходов спикера; решение —
 * по медиане: ниже 155 Гц — мужской, выше 175 — женский, между — неизвестно.
 */

export type VoiceGender = 'м' | 'ж' | '—';

export interface SpeakerProfile {
  gender: VoiceGender;
  /** Медиана основного тона, Гц; null — озвученных кадров не хватило. */
  f0: number | null;
  /** Сколько секунд звонкой речи легло в оценку. */
  voicedSeconds: number;
  /** Квартили тона: широкий разброс выдаёт октавные ошибки или шум вместо речи. */
  p25?: number;
  p75?: number;
}

export interface SpeechInterval {
  start: number;
  end: number;
  speaker: string;
}

export const MALE_MAX_HZ = 155;
export const FEMALE_MIN_HZ = 175;
/**
 * Меньше — оценка ненадёжна (короткие реплики, шум).
 *
 * Было 0.6 с: приговор о поле выносился по трём десяткам кадров и выходил
 * жребием. На девяти записях говорящие, у которых звонкой речи меньше полутора
 * секунд, — это ровно те шесть, чьи вердикты не выдерживали проверки
 * распределением; у всех остальных её от двух секунд и выше.
 */
export const MIN_VOICED_SECONDS = 1.5;

const FRAME = 1024;
const HOP = 320; // 20 мс при 16 кГц
/** Ниже 75 Гц речи почти не бывает, а гул двигателей и фон — как раз там. */
const F_MIN = 75;
const F_MAX = 400;
const YIN_THRESHOLD = 0.15;
const OCTAVE_MARGIN = 0.05;
const MIN_RMS = 0.01;
/** Тон принимается, только если держится подряд несколько кадров: шум так не умеет. */
const MIN_RUN = 3;
const MAX_JUMP = 0.2;

/**
 * Фильтр верхних частот (~80 Гц, два каскада первого порядка — 12 дБ на октаву):
 * убирает гул двигателей и фон, не трогая тон голоса.
 */
export function highPass(frame: Float32Array, sampleRate: number, cutoffHz = 80): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  let input = frame;
  let out = frame;
  for (let pass = 0; pass < 2; pass++) {
    out = new Float32Array(input.length);
    let previousIn = input[0] ?? 0;
    let previousOut = 0;
    for (let i = 1; i < input.length; i++) {
      const value = alpha * (previousOut + input[i]! - previousIn);
      out[i] = value;
      previousIn = input[i]!;
      previousOut = value;
    }
    input = out;
  }
  return out;
}

/**
 * Оставляет только устойчивые участки тона: не короче MIN_RUN кадров подряд
 * с отклонением между соседями не больше MAX_JUMP. Одиночные «попадания» на шуме
 * и октавные срывы на один кадр отбрасываются.
 */
export function stablePitches(sequence: Array<number | null>): number[] {
  const kept: number[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= MIN_RUN) kept.push(...run);
    run = [];
  };
  for (const pitch of sequence) {
    const last = run[run.length - 1];
    if (pitch === null || (last !== undefined && Math.abs(pitch - last) / last > MAX_JUMP)) {
      flush();
      if (pitch !== null) run = [pitch];
      continue;
    }
    run.push(pitch);
  }
  flush();
  return kept;
}

/** Основной тон кадра по YIN; null — кадр незвонкий. */
export function yinPitch(frame: Float32Array, sampleRate: number): number | null {
  const half = frame.length >> 1;
  const tauMin = Math.floor(sampleRate / F_MAX);
  const tauMax = Math.min(half, Math.floor(sampleRate / F_MIN));

  let energy = 0;
  for (let i = 0; i < half; i++) energy += frame[i]! * frame[i]!;
  if (Math.sqrt(energy / half) < MIN_RMS) return null;

  const diff = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j++) {
      const delta = frame[j]! - frame[j + tau]!;
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Нормированная кумулятивная разность: не зависит от громкости.
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau]!;
    cmnd[tau] = running === 0 ? 1 : (diff[tau]! * tau) / running;
  }

  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau]! < YIN_THRESHOLD) {
      while (tau + 1 <= tauMax && cmnd[tau + 1]! < cmnd[tau]!) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return null;

  // Октавная ошибка вверх: у голоса через рацию или при крике сильна вторая
  // гармоника, и первый провал оказывается на половине периода. Если провал
  // на удвоенном периоде заметно глубже — настоящий период там.
  const doubled = best * 2;
  if (doubled <= tauMax && cmnd[doubled]! < cmnd[best]! - OCTAVE_MARGIN) {
    best = doubled;
    while (best + 1 <= tauMax && cmnd[best + 1]! < cmnd[best]!) best++;
  }

  // Параболическое уточнение периода между соседними отсчётами.
  let period = best;
  if (best > 0 && best < tauMax) {
    const a = cmnd[best - 1]!;
    const b = cmnd[best]!;
    const c = cmnd[best + 1]!;
    const denominator = a - 2 * b + c;
    if (denominator !== 0) period = best + (a - c) / (2 * denominator);
  }
  return sampleRate / period;
}

/** Нижняя квартиль тона у мужчины — спокойная речь — ниже этого даже у тех, кто в основном кричит. */
export const MALE_QUARTILE_MAX_HZ = 150;
/** У женщины и спокойная речь выше этого. */
export const FEMALE_QUARTILE_MIN_HZ = 155;

/**
 * Решение по распределению тона, а не по одной медиане: мужчина в крике
 * поднимается до 250–350 Гц (первый эпизод: герой в скафандре, 225–345 Гц),
 * но его спокойные фразы остаются ниже 150 — поэтому мужской пол определяется
 * по нижней квартили. Женский — когда и нижняя квартиль, и медиана высокие.
 */
/**
 * Сколько материала нужно, зависит от того, насколько ответ очевиден.
 *
 * Голос на 93 Гц — мужской, сколько бы его ни слушать; требовать под него
 * полторы секунды звонкой речи бессмысленно, а на коротких ролях столько и не
 * набирается. А вот 190 Гц — это ровно та полоса, где мужчина и женщина
 * соседствуют, и там секунда записи даёт жребий, а не ответ.
 */
export const CLEAR_MALE_HZ = 120;
export const CLEAR_FEMALE_HZ = 260;
/** Абсолютный низ: меньше — это уже не замер, а несколько случайных кадров. */
export const MIN_VOICED_FLOOR_SECONDS = 0.6;

export function classifyGender(f0: number | null, voicedSeconds: number, p25: number | null = f0): VoiceGender {
  if (f0 === null || p25 === null || voicedSeconds < MIN_VOICED_FLOOR_SECONDS) return '—';
  // Материала меньше нормы — отвечаем, только если ответ не у границы.
  if (voicedSeconds < MIN_VOICED_SECONDS && f0 >= CLEAR_MALE_HZ && f0 <= CLEAR_FEMALE_HZ) return '—';
  if (p25 < MALE_QUARTILE_MAX_HZ && f0 < FEMALE_MIN_HZ + 100) return 'м';
  if (p25 >= FEMALE_QUARTILE_MIN_HZ && f0 > FEMALE_MIN_HZ) return 'ж';
  return '—';
}

/**
 * Сворачивает октавные ошибки к главному сгустку.
 *
 * YIN ошибается ровно вдвое: у мужского голоса первый провал попадает на
 * половину периода и тон выходит вдвое выше, у женского — наоборот. Отдельно
 * взятый кадр так не поправить: провал на удвоенном периоде бывает не глубже.
 * Зато на распределении это видно сразу — у мужчины из замеров сгусток на
 * 125–150 Гц и хвост на 250–400, у женщины сгусток 300–400 и хвост ниже 150.
 *
 * Поэтому решение принимается не по кадру, а по всему голосу: находится самый
 * плотный полутоновый бин, и каждый замер делится или умножается на два, пока
 * не окажется в пределах полуоктавы от него. На девяти записях это сузило
 * разброс между квартилями у 22 говорящих из 37, а у самых кривых — с ×2.36
 * до ×1.18.
 *
 * Без этого медиана и нижняя квартиль описывали разные сгустки: у одного
 * говорящего выходило «медиана 238 Гц, квартиль 132» — по медиане женщина, по
 * квартили мужчина. Отсюда и бралось ощущение случайности.
 */
export function foldOctaves(pitches: number[]): number[] {
  if (pitches.length === 0) return [];
  const logs = pitches.map((pitch) => Math.log2(pitch));

  const STEP = 1 / 12; // полутон
  const bins = new Map<number, number>();
  for (const value of logs) {
    const bin = Math.round(value / STEP);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  // Соседние бины учитываются с меньшим весом: голос не стоит на одной ноте,
  // и без сглаживания «самым плотным» оказывается случайный пик.
  let center = 0;
  let best = -1;
  for (const bin of bins.keys()) {
    const weight = (bins.get(bin - 1) ?? 0) + (bins.get(bin) ?? 0) * 2 + (bins.get(bin + 1) ?? 0);
    if (weight > best) {
      best = weight;
      center = bin * STEP;
    }
  }

  /*
   * Сворачивается только то, что стоит близко к ровной октаве от центра.
   *
   * Ошибка YIN — это ровно вдвое, по устройству алгоритма. Замер, отстоящий на
   * три четверти октавы, — не ошибка, а настоящая высота: так звучит мужчина,
   * повысивший голос. Его трогать нельзя, иначе крик станет женским голосом.
   */
  const OCTAVE_WINDOW = 2 / 12; // ±2 полутона от точной октавы
  const foldTo = (value: number, to: number): number => {
    let folded = value;
    while (folded - to > 0.5 && Math.abs(folded - to - 1) <= OCTAVE_WINDOW) folded -= 1;
    while (to - folded > 0.5 && Math.abs(to - folded - 1) <= OCTAVE_WINDOW) folded += 1;
    return folded;
  };
  // Уточнение центра медианой уже свёрнутых значений: бин задаёт его грубо.
  for (let pass = 0; pass < 3; pass++) {
    const folded = logs.map((value) => foldTo(value, center)).sort((a, b) => a - b);
    center = folded[Math.floor(folded.length / 2)] ?? center;
  }

  return logs.map((value) => 2 ** foldTo(value, center));
}

export function profileFromPitches(pitches: number[], secondsPerFrame: number): SpeakerProfile {
  if (pitches.length === 0) return { gender: '—', f0: null, voicedSeconds: 0 };
  // Квартили считаются по свёрнутым замерам: иначе они описывают разные октавы
  // одного голоса, и правило читает то один сгусток, то другой.
  const sorted = foldOctaves(pitches).sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!;
  const median = at(0.5);
  const voicedSeconds = pitches.length * secondsPerFrame;
  return {
    gender: classifyGender(median, voicedSeconds, at(0.25)),
    f0: Math.round(median),
    voicedSeconds: Number(voicedSeconds.toFixed(2)),
    p25: Math.round(at(0.25)),
    p75: Math.round(at(0.75)),
  };
}

interface WavLayout {
  sampleRate: number;
  channels: number;
  dataOffset: number;
  dataBytes: number;
}

async function readWavLayout(handle: Awaited<ReturnType<typeof open>>): Promise<WavLayout> {
  const header = Buffer.alloc(12);
  await handle.read(header, 0, 12, 0);
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('не WAV-файл');
  }
  let position = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  const chunk = Buffer.alloc(8);
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, 8, position);
    if (bytesRead < 8) throw new Error('в WAV нет блока data');
    const id = chunk.toString('ascii', 0, 4);
    const size = chunk.readUInt32LE(4);
    if (id === 'fmt ') {
      const fmt = Buffer.alloc(16);
      await handle.read(fmt, 0, 16, position + 8);
      channels = fmt.readUInt16LE(2);
      sampleRate = fmt.readUInt32LE(4);
      bits = fmt.readUInt16LE(14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`поддерживается только 16-битный PCM, получено ${bits} бит`);
      return { sampleRate, channels, dataOffset: position + 8, dataBytes: size };
    }
    position += 8 + size + (size % 2);
  }
}

/**
 * Профили спикеров по интервалам их речи в WAV (16 бит, любой канал берётся
 * первым). Файл читается кусками только внутри интервалов — целиком в память
 * двухчасовой фильм не влезает.
 */
export async function profileSpeakers(audioPath: string, intervals: SpeechInterval[]): Promise<Map<string, SpeakerProfile>> {
  const handle = await open(audioPath, 'r');
  try {
    const layout = await readWavLayout(handle);
    const bytesPerFrame = 2 * layout.channels;
    const totalSamples = Math.floor(layout.dataBytes / bytesPerFrame);
    const pitches = new Map<string, number[]>();

    for (const interval of intervals) {
      const startSample = Math.max(0, Math.floor(interval.start * layout.sampleRate));
      const endSample = Math.min(totalSamples, Math.floor(interval.end * layout.sampleRate));
      if (endSample - startSample < FRAME) continue;

      const bytes = Buffer.alloc((endSample - startSample) * bytesPerFrame);
      await handle.read(bytes, 0, bytes.length, layout.dataOffset + startSample * bytesPerFrame);
      const samples = new Float32Array(endSample - startSample);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * bytesPerFrame) / 32768;

      const filtered = highPass(samples, layout.sampleRate);
      const sequence: Array<number | null> = [];
      for (let offset = 0; offset + FRAME <= filtered.length; offset += HOP) {
        sequence.push(yinPitch(filtered.subarray(offset, offset + FRAME), layout.sampleRate));
      }
      const list = pitches.get(interval.speaker) ?? [];
      list.push(...stablePitches(sequence));
      pitches.set(interval.speaker, list);
    }

    const profiles = new Map<string, SpeakerProfile>();
    for (const speaker of new Set(intervals.map((interval) => interval.speaker))) {
      profiles.set(speaker, profileFromPitches(pitches.get(speaker) ?? [], HOP / layout.sampleRate));
    }
    return profiles;
  } finally {
    await handle.close();
  }
}
