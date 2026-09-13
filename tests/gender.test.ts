import { describe, it, expect } from 'vitest';
import {
  classifyGender,
  highPass,
  profileFromPitches,
  stablePitches,
  yinPitch,
  MIN_VOICED_SECONDS,
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
    expect(classifyGender(105, MIN_VOICED_SECONDS / 2)).toBe('—');
    expect(classifyGender(null, 5)).toBe('—');
  });

  it('профиль: квартили считаются и участвуют в решении', () => {
    const shouting = [...Array(30).fill(120), ...Array(70).fill(230)];
    const profile = profileFromPitches(shouting, 0.02);
    expect(profile.p25).toBe(120);
    expect(profile.gender).toBe('м');
    expect(profile.voicedSeconds).toBeCloseTo(2, 5);
    expect(profileFromPitches(Array(60).fill(112), 0.02).gender).toBe('м');
    expect(profileFromPitches([], 0.02)).toEqual({ gender: '—', f0: null, voicedSeconds: 0 });
  });
});
