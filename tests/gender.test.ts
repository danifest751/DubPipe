import { describe, it, expect } from 'vitest';
import {
  foldOctaves,
  classifyGender,
  highPass,
  profileFromPitches,
  stablePitches,
  yinPitch,
  MIN_VOICED_SECONDS,
  MIN_VOICED_FLOOR_SECONDS,
} from '../src/providers/diarization/gender.js';

const SR = 16_000;
const tone = (hz: number, seconds = 0.064, harmonics = 3): Float32Array => {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    let value = 0;
    for (let k = 1; k <= harmonics; k++) value += Math.sin((2 * Math.PI * hz * k * i) / SR) / k;
    out[i] = value * 0.3;
  }
  return out;
};

describe('FR-5: пол голоса по основному тону', () => {
  it('YIN находит тон мужского и женского голоса', () => {
    expect(yinPitch(tone(120), SR)).toBeCloseTo(120, 0);
    expect(yinPitch(tone(220), SR)).toBeCloseTo(220, 0);
  });

  it('тишина и шум — незвонкие кадры', () => {
    expect(yinPitch(new Float32Array(1024), SR)).toBeNull();
    let seed = 1;
    const noise = Float32Array.from({ length: 1024 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.4);
    expect(yinPitch(noise, SR)).toBeNull();
  });

  it('фильтр верхних частот убирает гул, но оставляет тон голоса', () => {
    const rumble = tone(30, 0.064, 1);
    const voice = tone(140, 0.064, 3);
    const mixed = Float32Array.from(voice, (value, index) => value + rumble[index]! * 3);
    expect(Math.abs(yinPitch(highPass(mixed, SR), SR)! - 140)).toBeLessThan(3);
  });

  it('устойчивый тон принимается, одиночные попадания и срывы — нет', () => {
    expect(stablePitches([110, 112, 111, null, 250, null, 115, 113, 114, 230, 231, 229])).toEqual([110, 112, 111, 115, 113, 114, 230, 231, 229]);
    expect(stablePitches([100, null, 100, null, 100])).toEqual([]);
  });

  it('решение по нижней квартили и медиане с зоной неуверенности', () => {
    expect(classifyGender(105, 5)).toBe('м');
    expect(classifyGender(190, 5)).toBe('ж');
    expect(classifyGender(165, 5)).toBe('—');
    // Мужчина, который в основном кричит: медиана 149, спокойная речь 119.
    expect(classifyGender(149, 5, 119)).toBe('м');
    // Женщина: и спокойная речь высокая.
    expect(classifyGender(184, 5, 174)).toBe('ж');
    // Смешанный кластер: низкая квартиль, но медиана заоблачная — не решаем.
    expect(classifyGender(300, 5, 120)).toBe('—');
    // Материала нет вовсе — не отвечаем даже на очевидном голосе.
    expect(classifyGender(105, MIN_VOICED_FLOOR_SECONDS / 2)).toBe('—');
    expect(classifyGender(null, 5)).toBe('—');
  });

  it('профиль: квартили считаются по свёрнутым замерам', () => {
    /*
     * Два сгустка ровно в октаве друг от друга теперь считаются одним голосом:
     * главный сгусток задаёт высоту, второй — ошибка YIN, которая всегда ровно
     * вдвое. Раньше здесь ожидалось обратное — что низкая квартиль выдаёт
     * мужчину, повысившего голос, — но на девяти записях это правило давало
     * вердикты, где медиана и квартиль описывали разные октавы одного голоса.
     * Различить крик и ошибку по одному лишь сигналу нельзя; выбрано то, что на
     * реальном материале даёт согласованные числа.
     */
    const profile = profileFromPitches([...Array(30).fill(120), ...Array(70).fill(240)], 0.02);
    expect(profile.p25).toBe(240);
    expect(profile.f0).toBe(240);
    expect(profile.voicedSeconds).toBeCloseTo(2, 5);

    // Ровный голос остаётся собой, сколько бы замеров ни было.
    expect(profileFromPitches(Array(120).fill(112), 0.02).gender).toBe('м');
    expect(profileFromPitches([], 0.02)).toEqual({ gender: '—', f0: null, voicedSeconds: 0 });
  });

  it('свёртка октав: хвост ровно в октаве уходит к главному сгустку', () => {
    // Мужской голос 130 Гц с удвоенным хвостом на 260: хвост обязан вернуться.
    const folded = foldOctaves([...Array(70).fill(130), ...Array(30).fill(260)]);
    expect(Math.max(...folded)).toBeCloseTo(130, 0);
    expect(Math.min(...folded)).toBeCloseTo(130, 0);
  });

  it('свёртка октав: женский голос с половинным хвостом собирается вверх', () => {
    const folded = foldOctaves([...Array(70).fill(320), ...Array(30).fill(160)]);
    expect(Math.min(...folded)).toBeCloseTo(320, 0);
  });

  it('свёртка октав: не трогает то, что до октавы не дотягивает', () => {
    // Три четверти октавы — это не ошибка алгоритма, а настоящая высота.
    const wide = [...Array(70).fill(140), ...Array(30).fill(235)];
    const folded = foldOctaves(wide).sort((a, b) => a - b);
    expect(folded[0]).toBeCloseTo(140, 0);
    expect(folded[folded.length - 1]).toBeCloseTo(235, 0);
  });

  it('свёртка октав: ровный голос остаётся нетронутым', () => {
    const steady = [118, 120, 122, 119, 121, 117, 123, 120];
    const folded = foldOctaves(steady).sort((a, b) => a - b);
    // Значения проходят через логарифм и обратно, поэтому сравнение с допуском.
    steady.sort((a, b) => a - b).forEach((value, index) => expect(folded[index]).toBeCloseTo(value, 6));
  });

  it('пустой список сворачивать нечего', () => {
    expect(foldOctaves([])).toEqual([]);
  });

  it('решение не выносится по горстке кадров', () => {
    // 35 кадров — это 0.7 с; на таком объёме вердикт был жребием.
    expect(profileFromPitches(Array(35).fill(190), 0.02).gender).toBe('—');
    expect(profileFromPitches(Array(120).fill(190), 0.02).gender).not.toBe('—');
  });
});

describe('FR-5: сколько материала нужно для вердикта', () => {
  it('очевидный голос не требует полутора секунд', () => {
    // 93 Гц — мужской, сколько его ни слушай; на короткой роли столько
    // звонкой речи и не набирается.
    expect(classifyGender(93, 1.0, 88)).toBe('м');
    expect(classifyGender(300, 1.0, 270)).toBe('ж');
  });

  it('пограничный голос на коротком материале остаётся неопределённым', () => {
    // 190 Гц — полоса, где мужчина и женщина соседствуют.
    expect(classifyGender(190, 1.0, 180)).toBe('—');
    expect(classifyGender(190, 3.0, 180)).toBe('ж');
  });

  it('несколько случайных кадров не считаются замером вовсе', () => {
    expect(classifyGender(93, 0.4, 88)).toBe('—');
  });
});
