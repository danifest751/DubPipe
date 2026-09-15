import { open } from 'node:fs/promises';
import { readWavFormat } from '../../util/wav.js';

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

/** Замер тона на одном кадре анализа: номер кадра внутри интервала и сама высота. */
export interface PitchFrame {
  index: number;
  hz: number;
}

/** Все замеры одного говорящего с привязкой ко времени записи, кадр к кадру. */
export interface PitchSamples {
  /** Середина кадра в секундах от начала файла. */
  times: number[];
  pitches: number[];
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
export function stablePitchRuns(sequence: Array<number | null>): PitchFrame[] {
  const kept: PitchFrame[] = [];
  let run: PitchFrame[] = [];
  const flush = () => {
    if (run.length >= MIN_RUN) kept.push(...run);
    run = [];
  };
  for (const [index, pitch] of sequence.entries()) {
    const last = run[run.length - 1];
    if (pitch === null || (last !== undefined && Math.abs(pitch - last.hz) / last.hz > MAX_JUMP)) {
      flush();
      if (pitch !== null) run = [{ index, hz: pitch }];
      continue;
    }
    run.push({ index, hz: pitch });
  }
  flush();
  return kept;
}

/** Номер кадра нужен только тому, кто спрашивает про отдельную реплику. */
export function stablePitches(sequence: Array<number | null>): number[] {
  return stablePitchRuns(sequence).map((frame) => frame.hz);
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

export function classifyGender(
  f0: number | null,
  voicedSeconds: number,
  p25: number | null = f0,
  // Сколько нужно материала, чтобы отвечать и про голоса у границы. Послабление
  // берут только там, где цена ошибки — вопрос человеку, а не выбор голоса.
  confidentSeconds: number = MIN_VOICED_SECONDS,
): VoiceGender {
  if (f0 === null || p25 === null || voicedSeconds < MIN_VOICED_FLOOR_SECONDS) return '—';
  // Материала меньше нормы — отвечаем, только если ответ не у границы.
  if (voicedSeconds < confidentSeconds && f0 >= CLEAR_MALE_HZ && f0 <= CLEAR_FEMALE_HZ) return '—';
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

/**
 * Сколько звонкой речи нужно, чтобы усомниться в говорящем.
 *
 * Меньше, чем требуется для выбора голоса (MIN_VOICED_SECONDS): там ошибка
 * означает мужской голос у героини на весь фильм, здесь — строчку «проверьте
 * реплику 35». Цена разная, значит и порог разный. Ниже абсолютного низа не
 * опускаемся: полсекунды — это уже не замер.
 */
export const DISPUTE_MIN_VOICED_SECONDS = MIN_VOICED_FLOOR_SECONDS;

export interface SegmentSpan {
  id: number;
  start: number;
  end: number;
  speaker: string;
}

/**
 * Профиль одной реплики — по её собственным кадрам, взятым из общего замера.
 *
 * Октавы сворачиваются по самой реплике, а не по говорящему: свернуть их к его
 * сгустку означало бы стереть ровно то, что ищем. Женский голос на 197 Гц стоит
 * от мужского центра в 110 Гц почти на ровную октаву, и сворачивание опустило бы
 * его к 98 Гц — спор исчез бы вместе с поводом для него.
 */
export function profileSpan(span: SegmentSpan, samples: PitchSamples | undefined, secondsPerFrame: number): SpeakerProfile {
  const own: number[] = [];
  for (let i = 0; i < (samples?.times.length ?? 0); i++) {
    const time = samples!.times[i]!;
    if (time >= span.start && time <= span.end) own.push(samples!.pitches[i]!);
  }
  return profileFromPitches(own, secondsPerFrame);
}

/** Спорит ли реплика со своим говорящим: оба пола определены и они разные. */
export function disputesSpeaker(line: SpeakerProfile, speaker: SpeakerProfile): boolean {
  if (speaker.gender === '—') return false;
  const own = classifyGender(line.f0, line.voicedSeconds, line.p25 ?? line.f0, DISPUTE_MIN_VOICED_SECONDS);
  return own !== '—' && own !== speaker.gender;
}

/**
 * Реплики, чей собственный тон спорит с приписанным им говорящим.
 *
 * Диаризация ошибается на коротких фразах: реплика достаётся соседу по сцене.
 * Машинно исправить это нельзя — правильный ответ знает только слушающий, — но
 * показать спорные строки человеку дёшево, а найти их иначе он может лишь
 * прослушав весь фильм.
 */
export function disputedSpans(
  spans: SegmentSpan[],
  speakers: Map<string, SpeakerProfile>,
  samples: Map<string, PitchSamples>,
  secondsPerFrame: number,
): Map<number, SpeakerProfile> {
  const disputed = new Map<number, SpeakerProfile>();
  for (const span of spans) {
    const speaker = speakers.get(span.speaker);
    if (!speaker) continue;
    const line = profileSpan(span, samples.get(span.speaker), secondsPerFrame);
    if (disputesSpeaker(line, speaker)) disputed.set(span.id, line);
  }
  return disputed;
}

/** Замеры всей записи: профили говорящих и те же кадры с временем каждого. */
export interface SpeechProfiles {
  speakers: Map<string, SpeakerProfile>;
  samples: Map<string, PitchSamples>;
  secondsPerFrame: number;
}

/**
 * Профили спикеров по интервалам их речи в WAV (16 бит, любой канал берётся
 * первым). Файл читается кусками только внутри интервалов — целиком в память
 * двухчасовой фильм не влезает.
 */
export async function profileSpeakers(audioPath: string, intervals: SpeechInterval[]): Promise<Map<string, SpeakerProfile>> {
  return (await profileSpeech(audioPath, intervals)).speakers;
}

/** То же самое, но с сохранением кадров: по ним спрашивают про отдельную реплику. */
export async function profileSpeech(audioPath: string, intervals: SpeechInterval[]): Promise<SpeechProfiles> {
  // Заголовок читает общая утилита: раньше здесь жил второй разбор RIFF,
  // отличавшийся от неё поведением на файлах с крупными метаданными.
  const layout = await readWavFormat(audioPath);
  if (layout.bitsPerSample !== 16) {
    throw new Error(`поддерживается только 16-битный PCM, получено ${layout.bitsPerSample} бит`);
  }
  const handle = await open(audioPath, 'r');
  try {
    const bytesPerFrame = 2 * layout.channels;
    const totalSamples = Math.floor(layout.dataLength / bytesPerFrame);
    const bySpeaker = new Map<string, PitchSamples>();

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
      const store = bySpeaker.get(interval.speaker) ?? { times: [], pitches: [] };
      for (const frame of stablePitchRuns(sequence)) {
        // Время середины кадра: по нему замер попадает в свою реплику.
        store.times.push((startSample + frame.index * HOP + FRAME / 2) / layout.sampleRate);
        store.pitches.push(frame.hz);
      }
      bySpeaker.set(interval.speaker, store);
    }

    const secondsPerFrame = HOP / layout.sampleRate;
    const profiles = new Map<string, SpeakerProfile>();
    for (const speaker of new Set(intervals.map((interval) => interval.speaker))) {
      profiles.set(speaker, profileFromPitches(bySpeaker.get(speaker)?.pitches ?? [], secondsPerFrame));
    }
    return { speakers: profiles, samples: bySpeaker, secondsPerFrame };
  } finally {
    await handle.close();
  }
}
