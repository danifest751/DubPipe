import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { describeCompute, deviceOptions, onnxDevice } from '../src/core/compute.js';
import { chooseAccel, classifyAdapters } from '../src/providers/asr/accel.js';
import type { PythonEnvironment } from '../src/stages/s4-separate.js';

const RADEON = classifyAdapters(['AMD Radeon 780M Graphics']);
const GEFORCE = classifyAdapters(['NVIDIA GeForce RTX 4060 Laptop GPU']);

const python = (providers: string[], available = true): PythonEnvironment => ({
  available,
  executable: 'python',
  missing: available ? [] : ['onnxruntime'],
  providers,
});

const withDml = python(['DmlExecutionProvider', 'CPUExecutionProvider']);
const cpuOnly = python(['CPUExecutionProvider']);

const map = (config = parseConfig({}, 'test'), hardware = RADEON, env = withDml) =>
  describeCompute(config, hardware, chooseAccel(config.asr.backend, hardware), env);

const stage = (name: string, m = map()) => m.stages.find((s) => s.stage === name)!;

describe('Карта вычислений', () => {
  it('называет исполнителя onnxruntime человеческим словом', () => {
    expect(onnxDevice(['DmlExecutionProvider', 'CPUExecutionProvider'])).toEqual({
      name: 'видеокарта (DirectML)',
      gpu: true,
    });
    expect(onnxDevice(['CUDAExecutionProvider'])).toMatchObject({ gpu: true });
    expect(onnxDevice(['CPUExecutionProvider'])).toEqual({ name: 'процессор', gpu: false });
    expect(onnxDevice([])).toMatchObject({ gpu: false });
  });

  it('показывает встроенную видеокарту как встроенную', () => {
    expect(map().adapters).toEqual(['AMD Radeon 780M Graphics (встроенная)']);
    expect(map(parseConfig({}, 'test'), GEFORCE).adapters[0]).toContain('отдельная');
  });

  it('о происхождении сборки говорит только когда она не официальная', () => {
    expect(stage('Распознавание речи').detail).not.toContain('собрана');
    const vulkan = parseConfig({ asr: { backend: 'vulkan' } }, 'test');
    expect(stage('Распознавание речи', map(vulkan)).detail).toContain('lemonade-sdk');
  });

  it('советует ускорение, которого не хватает', () => {
    // Видеокарта AMD есть, официальной сборки под неё нет — стоит подсказать.
    expect(map().hints.join(' ')).toContain('Vulkan');
    // Видеокарта есть, а onnxruntime видит только процессор.
    expect(map(parseConfig({}, 'test'), RADEON, cpuOnly).hints.join(' ')).toContain('onnxruntime-directml');
    // Всё уже задействовано — советовать нечего.
    expect(map(parseConfig({ asr: { backend: 'vulkan' } }, 'test')).hints).toEqual([]);
  });

  it('выключенные стадии так и называет', () => {
    const config = parseConfig({ asr: { diarization: { enabled: false } } }, 'test');
    expect(stage('Разбор по голосам', map(config)).where).toBe('выключен');
    expect(stage('Отделение голоса').where).toBe('выключено');
  });

  it('стадия, отправленная настройкой на процессор, не показывает видеокарту', () => {
    const onCpu = parseConfig({ separation: { enabled: true, device: 'cpu' } }, 'test');
    const onGpu = parseConfig({ separation: { enabled: true } }, 'test');
    expect(stage('Отделение голоса', map(onCpu)).where).toBe('процессор');
    expect(stage('Отделение голоса', map(onGpu)).where).toBe('видеокарта (DirectML)');
  });

  it('стадии на ffmpeg и piper всегда на процессоре', () => {
    expect(stage('Синтез речи').where).toBe('процессор');
    expect(stage('Укладка и сведение').where).toBe('процессор');
  });
});

describe('Настройки: список устройств по тому, что есть в системе', () => {
  const values = (options: { value: string }[]) => options.map((option) => option.value);

  it('видеокарта названа своим именем, а не «встроенной видеокартой»', () => {
    const { backend, device } = deviceOptions(RADEON);
    expect(device.find((option) => option.value === 'igpu')?.name).toBe('AMD Radeon 780M Graphics');
    expect(backend.find((option) => option.value === 'vulkan')?.name).toContain('AMD Radeon 780M Graphics');
  });

  it('CUDA не предлагается там, где нет NVIDIA', () => {
    // Выбранная на машине без NVIDIA, она означала молчаливый расчёт на процессоре.
    expect(values(deviceOptions(RADEON).backend)).not.toContain('cuda');
    expect(values(deviceOptions(RADEON).device)).not.toContain('cuda');
    expect(values(deviceOptions(GEFORCE).backend)).toContain('cuda');
  });

  it('сборки с Vulkan нет там, где под неё нет железа', () => {
    expect(values(deviceOptions(GEFORCE).backend)).not.toContain('vulkan');
    expect(values(deviceOptions(classifyAdapters([])).backend)).not.toContain('vulkan');
  });

  it('без видеокарт остаются только процессорные варианты', () => {
    const { backend, device } = deviceOptions(classifyAdapters([]));
    expect(values(backend)).toEqual(['auto', 'blas', 'cpu']);
    expect(values(device)).toEqual(['auto', 'cpu']);
  });

  it('несуществующих «видеокарты вообще» в списке больше нет', () => {
    expect(values(deviceOptions(RADEON).device)).not.toContain('gpu');
    expect(values(deviceOptions(RADEON).device)).not.toContain('dgpu');
  });

  it('у варианта либо своё имя, либо ключ перевода — но не пусто', () => {
    for (const hardware of [RADEON, GEFORCE, classifyAdapters([])]) {
      const { backend, device } = deviceOptions(hardware);
      for (const option of [...backend, ...device]) {
        expect(option.name ?? option.key).toBeTruthy();
      }
    }
  });
});
