#!/usr/bin/env python3
"""
Разделение аудио на вокал и фон моделью MDX-Net (ONNX).

Стадия S4 конвейера DubPipe. ТЗ §0.3 разрешает внешний процесс на Python именно
для этой стадии: спектральная обработка требует БПФ размера 6144 на каждый кадр,
и numpy делает это на порядки быстрее, чем реализация на JavaScript.

Зависимости: numpy, onnxruntime. PyTorch НЕ требуется.

Использование:
    python mdx_separate.py --model model.onnx --input mix.wav \
        --output-instrumental background.wav [--output-vocals vocals.wav]
"""
import argparse
import json
import sys
import wave

import numpy as np

# Node читает потоки как UTF-8; без этого русские сообщения об ошибках
# приходят в кодировке консоли Windows и превращаются в кракозябры.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

try:
    import onnxruntime as ort
except ImportError:
    print(json.dumps({"error": "не установлен onnxruntime: pip install onnxruntime"}), file=sys.stderr)
    raise SystemExit(2)


# Параметры модели UVR-MDX-NET (Inst_HQ_3 и родственные).
N_FFT = 6144
HOP = 1024
DIM_F = 3072
DIM_T = 256
N_BINS = N_FFT // 2 + 1
CHUNK = HOP * (DIM_T - 1)
TRIM = N_FFT // 2
# Модель немного занижает уровень; коэффициент из конфигурации UVR.
COMPENSATE = 1.021


def read_wav(path):
    """Читает WAV 16 бит и возвращает (float32 [2, N], частота дискретизации)."""
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError(f"поддерживается только 16-битный PCM, получено {width * 8} бит")

    data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    data = data.reshape(-1, channels).T
    if channels == 1:
        data = np.vstack([data, data])
    elif channels > 2:
        data = data[:2]
    return np.ascontiguousarray(data), rate


def write_wav(path, samples, rate):
    """Пишет WAV 16 бит из float32 [2, N] с защитой от клиппинга."""
    clipped = np.clip(samples, -1.0, 1.0)
    interleaved = (clipped.T.reshape(-1) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(samples.shape[0])
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(interleaved.tobytes())


def make_window():
    # Периодическое окно Ханна — то же, что torch.hann_window(periodic=True).
    return np.hanning(N_FFT + 1)[:-1].astype(np.float32)


WINDOW = make_window()


def stft(signal):
    """[C, CHUNK] -> комплексный спектр [C, N_BINS, DIM_T], center=True."""
    padded = np.pad(signal, ((0, 0), (N_FFT // 2, N_FFT // 2)), mode="reflect")
    starts = np.arange(DIM_T) * HOP
    frames = np.stack([padded[:, s : s + N_FFT] for s in starts], axis=1)
    return np.fft.rfft(frames * WINDOW, axis=-1).transpose(0, 2, 1)


def istft(spec, length):
    """Комплексный спектр [C, N_BINS, T] -> сигнал [C, length]."""
    frames = np.fft.irfft(spec.transpose(0, 2, 1), n=N_FFT, axis=-1)
    channels, count, _ = frames.shape
    total = (count - 1) * HOP + N_FFT

    output = np.zeros((channels, total), dtype=np.float32)
    norm = np.zeros(total, dtype=np.float32)
    squared = WINDOW**2
    for index in range(count):
        start = index * HOP
        output[:, start : start + N_FFT] += frames[:, index] * WINDOW
        norm[start : start + N_FFT] += squared

    norm[norm < 1e-8] = 1e-8
    output /= norm
    # Снимаем дополнение, добавленное при center=True.
    return output[:, N_FFT // 2 : N_FFT // 2 + length]


def to_model_input(spec):
    """[2, N_BINS, T] -> [1, 4, DIM_F, T]: канал × (действительная, мнимая)."""
    cut = spec[:, :DIM_F, :]
    stacked = np.stack([cut.real, cut.imag], axis=1)
    return stacked.reshape(1, 4, DIM_F, DIM_T).astype(np.float32)


def from_model_output(tensor):
    """[1, 4, DIM_F, T] -> комплексный спектр [2, N_BINS, T] с добором нулями."""
    reshaped = tensor.reshape(2, 2, DIM_F, DIM_T)
    complex_spec = reshaped[:, 0] + 1j * reshaped[:, 1]
    pad = np.zeros((2, N_BINS - DIM_F, DIM_T), dtype=complex_spec.dtype)
    return np.concatenate([complex_spec, pad], axis=1)


def separate(session, mix, progress=True):
    """Прогоняет микс через модель перекрывающимися окнами."""
    channels, length = mix.shape
    generated = CHUNK - 2 * TRIM
    pad = generated + TRIM - (length % generated)
    padded = np.concatenate(
        [np.zeros((channels, TRIM), dtype=np.float32), mix, np.zeros((channels, pad), dtype=np.float32)],
        axis=1,
    )

    result = np.zeros((channels, length + pad), dtype=np.float32)
    total = (length + pad) // generated + 1
    name_in = session.get_inputs()[0].name
    name_out = session.get_outputs()[0].name

    for index, start in enumerate(range(0, length + pad, generated)):
        window = padded[:, start : start + CHUNK]
        if window.shape[1] < CHUNK:
            window = np.pad(window, ((0, 0), (0, CHUNK - window.shape[1])))

        spec = stft(window)
        predicted = session.run([name_out], {name_in: to_model_input(spec)})[0]
        restored = istft(from_model_output(predicted), CHUNK)

        piece = restored[:, TRIM : TRIM + generated]
        take = min(piece.shape[1], result.shape[1] - start)
        result[:, start : start + take] = piece[:, :take]

        if progress:
            print(f"progress={min(100, round((index + 1) / total * 100))}", file=sys.stderr, flush=True)

    return result[:, :length] * COMPENSATE


def main():
    parser = argparse.ArgumentParser(description="Разделение вокала и фона моделью MDX-Net")
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-instrumental", required=True)
    parser.add_argument("--output-vocals")
    parser.add_argument("--threads", type=int, default=0)
    args = parser.parse_args()

    mix, rate = read_wav(args.input)
    if rate != 44100:
        print(
            json.dumps({"error": f"ожидается 44100 Гц, получено {rate}"}),
            file=sys.stderr,
        )
        raise SystemExit(2)

    options = ort.SessionOptions()
    if args.threads > 0:
        options.intra_op_num_threads = args.threads
    session = ort.InferenceSession(args.model, options, providers=["CPUExecutionProvider"])

    primary = separate(session, mix)
    residual = mix - primary

    write_wav(args.output_instrumental, primary, rate)
    if args.output_vocals:
        write_wav(args.output_vocals, residual, rate)

    print(json.dumps({"ok": True, "samples": int(mix.shape[1]), "rate": rate}))


if __name__ == "__main__":
    main()
