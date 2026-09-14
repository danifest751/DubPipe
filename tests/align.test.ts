import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  alignmentStats,
  passthroughPlan,
  planAlignment,
  shortenTargetChars,
  type AlignmentOptions,
} from '../src/stages/s6-align.js';
import { measureSpeechRate, ttsKey } from '../src/stages/s5-tts.js';
import { envelopeValueAt } from '../src/util/pcm.js';
import { speechWindows, defaultOutputName, defaultOutputPath, resolveOutputPath } from '../src/stages/s7-mix.js';
import { voiceForSpeaker, voiceUrlPath } from '../src/providers/tts/voices.js';
import { makeSegment, type Segment } from '../src/core/types.js';
import type { StageError } from '../src/core/errors.js';

const options = (overrides: Partial<AlignmentOptions> = {}): AlignmentOptions => ({
  minTempo: 0.9,
  maxTempo: 1.25,
  gapMs: 50,
  maxShiftMs: 1500,
  driftResetGapMs: 700,
  // Правила ниже описывают укладку в собственный слот реплики; занятие паузы
  // проверяется отдельно, своими тестами.
  borrowSilenceMs: 0,
  ...overrides,
});

const seg = (id: number, start: number, end: number, ttsDuration: number | null): Segment =>
  makeSegment({ id, start, end, text_en: `line ${id}`, text_ru: `реплика ${id}`, tts_duration: ttsDuration });

describe('FR-6.1: синтез короче слота', () => {
  it('оставляет темп и таймкод нетронутыми', () => {
    const [item] = planAlignment([seg(0, 1, 3, 1.2)], options());
    expect(item!.tempo).toBe(1);
    expect(item!.alignedStart).toBe(1);
    expect(item!.shiftMs).toBe(0);
    expect(item!.needsShorten).toBe(false);
  });
});

describe('FR-6.2: ускорение в пределах max_tempo', () => {
  it('подбирает темп ровно под слот', () => {
    const [item] = planAlignment([seg(0, 0, 2, 2.4)], options());
    expect(item!.tempo).toBeCloseTo(1.2, 3);
    expect(item!.effectiveDuration).toBeCloseTo(2, 2);
    expect(item!.needsShorten).toBe(false);
  });

  it('не превышает max_tempo и помечает реплику к сокращению', () => {
    const [item] = planAlignment([seg(0, 0, 2, 4)], options());
    expect(item!.tempo).toBe(1.25);
    expect(item!.needsShorten).toBe(true);
  });

  it('берёт границы темпа из конфига, а не из константы', () => {
    const [item] = planAlignment([seg(0, 0, 2, 4)], options({ maxTempo: 2 }));
    expect(item!.tempo).toBe(2);
    expect(item!.needsShorten).toBe(false);
  });
});

describe('FR-6.4: реплики не перекрываются', () => {
  it('сдвигает следующую реплику на зазор', () => {
    // Первая идёт 3 с при слоте 2 с и ускорении до 1.25 → занимает 2.4 с.
    const plan = planAlignment([seg(0, 0, 2, 3), seg(1, 2.1, 4, 1)], options());
    expect(plan[1]!.alignedStart).toBeGreaterThanOrEqual(plan[0]!.alignedStart + plan[0]!.effectiveDuration + 0.049);
    expect(plan[1]!.shiftMs).toBeGreaterThan(0);
  });

  it('не сдвигает, когда места хватает', () => {
    const plan = planAlignment([seg(0, 0, 2, 1.5), seg(1, 3, 5, 1.5)], options());
    expect(plan[1]!.shiftMs).toBe(0);
  });
});

describe('FR-6.5: контроль накопленного дрейфа', () => {
  it('не даёт сдвигу превысить предел', () => {
    // Цепочка длинных реплик подряд без пауз: сдвиг обязан упереться в предел.
    const segments = Array.from({ length: 8 }, (_, i) => seg(i, i * 2, i * 2 + 2, 3.5));
    const plan = planAlignment(segments, options({ maxShiftMs: 800 }));
    for (const item of plan) expect(item.shiftMs).toBeLessThanOrEqual(800);
  });

  it('обрезает реплику, когда сдвиг упёрся в предел', () => {
    const segments = Array.from({ length: 6 }, (_, i) => seg(i, i * 2, i * 2 + 2, 4));
    const plan = planAlignment(segments, options({ maxShiftMs: 500 }));
    const truncated = plan.filter((item) => item.truncateTo !== null);
    expect(truncated.length).toBeGreaterThan(0);
    for (const item of truncated) expect(item.effectiveDuration).toBeLessThanOrEqual(item.slot + 1e-6);
  });

  it('сбрасывает накопленный сдвиг на длинной паузе', () => {
    const segments = [
      seg(0, 0, 2, 3.5),
      seg(1, 2.05, 4, 3.5),
      // Пауза 2 с — дольше drift_reset_gap_ms, сдвиг обязан обнулиться.
      seg(2, 6, 8, 1),
    ];
    const plan = planAlignment(segments, options());
    expect(plan[1]!.shiftMs).toBeGreaterThan(0);
    expect(plan[2]!.shiftMs).toBe(0);
    expect(plan[2]!.alignedStart).toBe(6);
  });

  it('без пауз дрейф не обнуляется сам собой', () => {
    const segments = [seg(0, 0, 2, 3.5), seg(1, 2.05, 4, 3.5), seg(2, 4.1, 6, 1)];
    const plan = planAlignment(segments, options());
    expect(plan[2]!.shiftMs).toBeGreaterThan(0);
  });
});

describe('FR-6.6: сводка по подгонке', () => {
  it('считает медиану, максимум и долю вне допуска', () => {
    const plan = planAlignment(
      [seg(0, 0, 2, 1), seg(1, 2.05, 4, 3.5), seg(2, 4.1, 6, 3.5)],
      options(),
    );
    const stats = alignmentStats(plan);
    expect(stats.count).toBe(3);
    expect(stats.maxShiftMs).toBeGreaterThan(0);
    expect(stats.outsideToleranceShare).toBeGreaterThanOrEqual(0);
    expect(stats.speedUp).toBeGreaterThan(0);
  });

  it('пустой план не ломает сводку', () => {
    expect(alignmentStats([])).toEqual({
      count: 0,
      medianShiftMs: 0,
      maxShiftMs: 0,
      outsideToleranceShare: 0,
      speedUp: 0,
      truncated: 0,
    });
  });
});

describe('FR-6.3: цель сокращения', () => {
  it('учитывает максимальный темп', () => {
    expect(shortenTargetChars(2, 10, 1.25)).toBe(25);
    expect(shortenTargetChars(0.1, 10, 1.25)).toBe(4); // нижняя граница
  });
});

describe('S6 отключена: размещение по исходным таймкодам', () => {
  it('не меняет ни темп, ни старт', () => {
    const plan = passthroughPlan([seg(0, 1, 3, 4)]);
    expect(plan[0]!.tempo).toBe(1);
    expect(plan[0]!.alignedStart).toBe(1);
    expect(plan[0]!.needsShorten).toBe(true);
  });
});

describe('FR-5: калибровка темпа речи', () => {
  // Длительность реплики — это надбавка плюс знаки, делённые на темп.
  // Синтезируем данные по этому закону и проверяем, что подгонка его находит.
  const made = (rate: number, overhead: number, lengths: number[]) =>
    lengths.map((chars, id) =>
      makeSegment({
        id,
        start: id * 10,
        end: id * 10 + 5,
        text_en: 'line',
        text_ru: 'а'.repeat(chars),
        tts_duration: Number((overhead + chars / rate).toFixed(4)),
      }),
    );

  it('находит и темп, и надбавку', () => {
    const shape = measureSpeechRate(made(17.8, 0.51, [5, 10, 20, 30, 40, 60, 80, 120]));
    expect(shape!.charsPerSecond).toBeCloseTo(17.8, 1);
    expect(shape!.overheadSeconds).toBeCloseTo(0.51, 2);
  });

  it('без надбавки возвращает чистый темп', () => {
    const shape = measureSpeechRate(made(10, 0, [10, 20, 30, 40, 50, 60, 70, 80]));
    expect(shape!.charsPerSecond).toBeCloseTo(10, 1);
    expect(shape!.overheadSeconds).toBeCloseTo(0, 2);
  });

  it('не делает выводов по нескольким репликам', () => {
    // Подгонка прямой по трём точкам — самообман: разброс темпа у одного
    // голоса больше, чем разница между голосами.
    expect(measureSpeechRate([])).toBeNull();
    expect(measureSpeechRate(made(12, 0.4, [10, 20, 30]))).toBeNull();
  });

  it('однообразный материал не ломает замер', () => {
    // Все реплики одной длины: наклон не определить, но средний темп честен.
    const shape = measureSpeechRate(made(12, 0, [20, 20, 20, 20, 20, 20, 20, 20]));
    expect(shape!.charsPerSecond).toBeCloseTo(12, 1);
    expect(shape!.overheadSeconds).toBe(0);
  });
});

describe('FR-4: огибающая приглушения', () => {
  const windows = [{ start: 2, end: 4 }];
  const duckGain = 10 ** (-18 / 20);

  it('вне речи оригинал не трогается', () => {
    expect(envelopeValueAt(0.5, windows, duckGain, 0.12)).toBe(1);
    expect(envelopeValueAt(10, windows, duckGain, 0.12)).toBe(1);
  });

  it('внутри речи приглушает ровно на заданную величину', () => {
    expect(envelopeValueAt(3, windows, duckGain, 0.12)).toBeCloseTo(duckGain, 6);
  });

  it('на краях окна идёт плавный переход', () => {
    const before = envelopeValueAt(1.94, windows, duckGain, 0.12);
    expect(before).toBeLessThan(1);
    expect(before).toBeGreaterThan(duckGain);

    const after = envelopeValueAt(4.06, windows, duckGain, 0.12);
    expect(after).toBeLessThan(1);
    expect(after).toBeGreaterThan(duckGain);
  });
});

describe('FR-7: подготовка к сведению', () => {
  it('берёт речевые окна VAD, когда они есть', () => {
    const vad = [{ start: 1, end: 2 }];
    expect(speechWindows([seg(0, 5, 6, 1)], vad)).toEqual(vad);
  });

  it('без VAD использует слоты реплик', () => {
    expect(speechWindows([seg(0, 5, 6, 1)], null)).toEqual([{ start: 5, end: 6 }]);
  });

  it('строит имя итогового файла', () => {
    expect(defaultOutputName('C:/video/lecture.mkv', '.mp4')).toBe('lecture.ru.mp4');
    expect(defaultOutputName('https://youtu.be/xyz', '.mp4')).toBe('dubbed.ru.mp4');
    expect(defaultOutputName('podcast.mp3', '.m4a')).toBe('podcast.ru.m4a');
  });

  it('по умолчанию итог ложится рядом с исходным файлом, а не в текущий каталог', () => {
    const beside = defaultOutputPath(path.join('C:', 'video', 'lecture.mkv'), '.mp4');
    expect(path.dirname(beside)).toBe(path.resolve(path.join('C:', 'video')));
    expect(path.basename(beside)).toBe('lecture.ru.mp4');
  });

  it('для ссылки берётся запасная папка, иначе текущий каталог', () => {
    expect(defaultOutputPath('https://youtu.be/xyz', '.mp4', path.join('D:', 'dubs'))).toBe(
      path.join('D:', 'dubs', 'dubbed.ru.mp4'),
    );
    expect(path.dirname(defaultOutputPath('https://youtu.be/xyz', '.mp4'))).toBe(process.cwd());
  });

  it('приоритет: явный путь, папка назначения, настройка, рядом с исходным', () => {
    const input = path.join('C:', 'video', 'lecture.mkv');
    const options = { input, extension: '.mp4' };
    expect(resolveOutputPath({ ...options, outputOverride: path.join('E:', 'a.mp4'), outputDir: path.join('E:', 'dir'), configured: path.join('E:', 'c.mp4') })).toBe(
      path.resolve(path.join('E:', 'a.mp4')),
    );
    expect(resolveOutputPath({ ...options, outputDir: path.join('E:', 'dir'), configured: path.join('E:', 'c.mp4') })).toBe(
      path.join(path.resolve(path.join('E:', 'dir')), 'lecture.ru.mp4'),
    );
    expect(resolveOutputPath({ ...options, configured: path.join('E:', 'c.mp4') })).toBe(path.resolve(path.join('E:', 'c.mp4')));
    expect(resolveOutputPath(options)).toBe(path.join(path.resolve(path.join('C:', 'video')), 'lecture.ru.mp4'));
  });
});

describe('FR-5: голоса', () => {
  it('раскладывает имя голоса в путь каталога', () => {
    expect(voiceUrlPath('ru_RU-irina-medium')).toBe('ru/ru_RU/irina/medium/ru_RU-irina-medium');
    expect(voiceUrlPath('en_GB-alan-low')).toBe('en/en_GB/alan/low/en_GB-alan-low');
  });

  it('отвергает непонятное имя и подсказывает формат', () => {
    try {
      voiceUrlPath('какой-то-голос');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as Error).message).toContain('[s5]');
      expect((error as StageError).hints.join(' ')).toContain('ru_RU-irina-medium');
    }
  });

  it('назначает голос по спикеру, иначе голос по умолчанию', () => {
    const map = { speaker_1: 'ru_RU-dmitri-medium' };
    expect(voiceForSpeaker('speaker_1', map, 'ru_RU-irina-medium')).toBe('ru_RU-dmitri-medium');
    expect(voiceForSpeaker('speaker_0', map, 'ru_RU-irina-medium')).toBe('ru_RU-irina-medium');
  });
});

describe('FR-6.2: пауза после реплики идёт в дело', () => {
  // Сокращение перевода теряет смысл, а сдвиг конца реплики на секунду — нет.
  // Поэтому тишина после реплики занимается раньше, чем текст режется.
  const borrowing = options({ borrowSilenceMs: 1200 });

  it('реплика, не влезавшая в слот, укладывается за счёт паузы', () => {
    // Слот 2 с, синтез 3 с: в свой слот не влезает даже на максимальном темпе.
    const segments = [seg(0, 0, 2, 3), seg(1, 10, 12, 1)];
    const strict = planAlignment(segments, options())[0]!;
    expect(strict.needsShorten).toBe(true);

    const relaxed = planAlignment(segments, borrowing)[0]!;
    expect(relaxed.needsShorten).toBe(false);
    // Темпа хватило умеренного: 3 с в 3.2 с доступного места.
    expect(relaxed.tempo).toBeLessThan(1.05);
  });

  it('занимает не больше разрешённого, даже если пауза огромная', () => {
    const segments = [seg(0, 0, 2, 9), seg(1, 60, 62, 1)];
    const item = planAlignment(segments, borrowing)[0]!;
    // Доступно 2 с слота плюс 1.2 с паузы, а не все пятьдесят восемь.
    expect(item.slot).toBeCloseTo(3.2, 3);
    expect(item.needsShorten).toBe(true);
  });

  it('не залезает на следующую реплику', () => {
    // Между репликами всего 0.3 с, из них 0.05 — обязательный зазор.
    const segments = [seg(0, 0, 2, 3), seg(1, 2.3, 4, 1)];
    const item = planAlignment(segments, borrowing)[0]!;
    expect(item.slot).toBeCloseTo(2.25, 3);
  });

  it('у последней реплики пауза берётся из запаса', () => {
    const item = planAlignment([seg(0, 0, 2, 2.8)], borrowing)[0]!;
    expect(item.slot).toBeCloseTo(3.2, 3);
    expect(item.needsShorten).toBe(false);
  });

  it('ноль возвращает прежнее поведение', () => {
    const segments = [seg(0, 0, 2, 3), seg(1, 10, 12, 1)];
    expect(planAlignment(segments, options({ borrowSilenceMs: 0 }))[0]!.slot).toBeCloseTo(2, 3);
  });
});

describe('FR-5: что уже озвучено, тем же и остаётся', () => {
  it('отпечаток меняется вместе с голосом', () => {
    // Из-за того, что это не проверялось, смена голоса не переозвучивала ничего:
    // файлы лежали на месте, и стадия считала их годными.
    expect(ttsKey('ru_RU-irina-medium', 'Привет')).not.toBe(ttsKey('ru_RU-denis-medium', 'Привет'));
  });

  it('отпечаток меняется вместе с текстом', () => {
    expect(ttsKey('ru_RU-irina-medium', 'Привет')).not.toBe(ttsKey('ru_RU-irina-medium', 'Прощай'));
  });

  it('пробелы по краям текста ничего не значат', () => {
    expect(ttsKey('ru_RU-irina-medium', '  Привет  ')).toBe(ttsKey('ru_RU-irina-medium', 'Привет'));
  });
});
