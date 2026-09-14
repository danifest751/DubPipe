import { describe, it, expect } from 'vitest';
import { mixFilters } from '../src/stages/s7-mix.js';
import { envelopeValueAt } from '../src/util/pcm.js';

describe('Сведение: что делать с оригиналом', () => {
  const graph = (mode: Parameters<typeof mixFilters>[0]) => mixFilters(mode, -6, 0).join(';');

  it('приглушение умножает оригинал на огибающую', () => {
    expect(graph('duck')).toContain('[0:a][2:a]amultiply[ducked]');
    expect(graph('duck')).toContain('[ducked]volume=-6dB[bg]');
  });

  it('вычитание берёт выделенный голос, гасит его вне речи и вычитает', () => {
    const filters = mixFilters('subtract', -6, 0);
    // Голос умножается на огибающую присутствия речи: вне реплик она ноль.
    expect(filters[0]).toBe('[2:a][3:a]amultiply[removable]');
    // Вычитание — инверсия фазы и суммирование: через веса amix не работает.
    expect(filters[1]).toBe('[removable]volume=-1[inverted]');
    expect(filters[2]).toContain('normalize=0[clean]');
    expect(filters[3]).toBe('[clean]volume=-6dB[bg]');
  });

  it('полная замена фона ничего из оригинала не берёт', () => {
    const filters = mixFilters('separated', -6, 0);
    expect(filters[0]).toBe('[0:a]volume=-6dB[bg]');
    expect(filters.join(';')).not.toContain('amultiply');
    expect(filters.join(';')).not.toContain('volume=-1');
  });

  it('во всех режимах речь кладётся поверх и громкости применяются', () => {
    for (const mode of ['duck', 'subtract', 'separated'] as const) {
      const filters = mixFilters(mode, -6, 2);
      expect(filters.at(-1)).toBe('[bg][voice]amix=inputs=2:duration=first:normalize=0[mixed]');
      expect(filters.join(';')).toContain('[1:a]volume=2dB');
    }
  });
});

describe('Огибающая присутствия речи', () => {
  const windows = [{ start: 10, end: 12 }];
  // Единица под репликой, ноль вне её — обратная той, что приглушает оригинал.
  const presence = (t: number) => envelopeValueAt(t, windows, 1, 0.1, 0);

  it('вне реплики ровно ноль: оригинал не тронут', () => {
    expect(presence(5)).toBe(0);
    expect(presence(20)).toBe(0);
    // Точно на границе перехода тоже ноль — вычитать ещё нечего.
    expect(presence(9.9)).toBeCloseTo(0, 6);
  });

  it('под репликой единица: исходный голос убирается целиком', () => {
    expect(presence(11)).toBe(1);
  });

  it('переходы плавные, без щелчка на стыке', () => {
    expect(presence(9.95)).toBeCloseTo(0.5, 2);
    expect(presence(12.05)).toBeCloseTo(0.5, 2);
  });

  it('приглушение осталось прежним: единица снаружи, тише внутри', () => {
    const duck = (t: number) => envelopeValueAt(t, windows, 0.125, 0.1);
    expect(duck(5)).toBe(1);
    expect(duck(11)).toBe(0.125);
  });
});
