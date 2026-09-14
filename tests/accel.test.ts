import { describe, it, expect } from 'vitest';
import {
  ACCEL_BUILDS,
  accelDir,
  chooseAccel,
  classifyAdapters,
  fits,
  gpuKind,
} from '../src/providers/asr/accel.js';

// Названия адаптеров взяты как есть из Win32_VideoController на живых машинах.
const RADEON_780M = ['AMD Radeon 780M Graphics'];
const GEFORCE = ['NVIDIA GeForce RTX 4060 Laptop GPU'];
const INTEL = ['Intel(R) Iris(R) Xe Graphics'];
const HYBRID = ['Intel(R) UHD Graphics', 'NVIDIA GeForce GTX 1650'];

describe('Определение видеокарты', () => {
  it('узнаёт производителя по названию адаптера', () => {
    expect(classifyAdapters(RADEON_780M)).toMatchObject({ amd: true, nvidia: false, intel: false });
    expect(classifyAdapters(GEFORCE)).toMatchObject({ nvidia: true, amd: false });
    expect(classifyAdapters(INTEL)).toMatchObject({ intel: true, nvidia: false, amd: false });
  });

  it('в ноутбуке с двумя видеокартами видит обе', () => {
    const hardware = classifyAdapters(HYBRID);
    expect(hardware.nvidia).toBe(true);
    expect(hardware.intel).toBe(true);
  });

  it('без видеокарт ничего не выдумывает', () => {
    expect(classifyAdapters([])).toMatchObject({ nvidia: false, amd: false, intel: false, adapters: [] });
  });
});

describe('Выбор сборки whisper.cpp', () => {
  it('сам выбирает только официальные сборки', () => {
    // У NVIDIA официальная сборка есть — её и берём.
    expect(chooseAccel('auto', classifyAdapters(GEFORCE)).build.id).toBe('cuda');
    // У AMD официальной сборки нет: Vulkan существует, но подставлять чужой
    // бинарник без ведома человека нельзя.
    const amd = chooseAccel('auto', classifyAdapters(RADEON_780M));
    expect(amd.build.id).toBe('blas');
    expect(amd.reason).toContain('вручную');
    expect(chooseAccel('auto', classifyAdapters([])).build.id).toBe('blas');
  });

  it('каждая сборка, выбираемая сама, — из релизов whisper.cpp', () => {
    for (const hardware of [GEFORCE, RADEON_780M, INTEL, []]) {
      expect(chooseAccel('auto', classifyAdapters(hardware)).build.origin.official).toBe(true);
    }
  });

  it('ручной выбор Vulkan предупреждает, чей это архив', () => {
    const choice = chooseAccel('vulkan', classifyAdapters(RADEON_780M));
    expect(choice.build.id).toBe('vulkan');
    expect(choice.build.origin.official).toBe(false);
    expect(choice.warning).toContain('lemonade-sdk');
  });

  it('ручной выбор без подходящего железа предупреждает и об этом', () => {
    const choice = chooseAccel('cuda', classifyAdapters(RADEON_780M));
    expect(choice.build.id).toBe('cuda');
    expect(choice.warning).toContain('Radeon 780M');
  });

  it('процессорные сборки подходят любому железу', () => {
    for (const id of ['cpu', 'blas'] as const) {
      expect(fits(ACCEL_BUILDS[id], classifyAdapters([]))).toBe(true);
    }
    expect(fits(ACCEL_BUILDS.cuda, classifyAdapters(RADEON_780M))).toBe(false);
    expect(fits(ACCEL_BUILDS.vulkan, classifyAdapters(RADEON_780M))).toBe(true);
  });
});

describe('Размещение сборок', () => {
  it('обычная сборка остаётся там же, где стояла', () => {
    // Иначе у всех, кто уже пользуется программой, whisper скачался бы заново.
    expect(accelDir('blas')).toBe('whisper');
  });

  it('сборки под видеокарту лежат каждая в своём каталоге', () => {
    expect(accelDir('vulkan')).toBe('whisper-vulkan');
    expect(accelDir('cuda')).toBe('whisper-cuda');
    expect(new Set(['blas', 'cpu', 'cuda', 'vulkan'].map((id) => accelDir(id as never))).size).toBe(4);
  });
});

describe('Встроенная видеокарта или отдельная', () => {
  it('графику внутри процессора узнаёт по имени', () => {
    expect(gpuKind('AMD Radeon 780M Graphics')).toBe('integrated');
    expect(gpuKind('AMD Radeon(TM) 760M Graphics')).toBe('integrated');
    expect(gpuKind('Intel(R) UHD Graphics')).toBe('integrated');
    expect(gpuKind('Intel(R) Iris(R) Xe Graphics')).toBe('integrated');
    expect(gpuKind('AMD Radeon(TM) Vega 8 Graphics')).toBe('integrated');
  });

  it('отдельную карту не путает со встроенной', () => {
    // «Radeon» есть и там, и там — решают RX и номер модели.
    expect(gpuKind('AMD Radeon RX 7800 XT')).toBe('discrete');
    expect(gpuKind('NVIDIA GeForce RTX 4060 Laptop GPU')).toBe('discrete');
    expect(gpuKind('Intel(R) Arc(TM) A770 Graphics')).toBe('discrete');
    expect(gpuKind('AMD Radeon Pro W6600')).toBe('discrete');
  });

  it('незнакомое имя считает отдельной картой', () => {
    // Ошибиться в эту сторону дешевле: человека не отговаривают от ускорения.
    expect(gpuKind('Some Future GPU 9000')).toBe('discrete');
  });
});
