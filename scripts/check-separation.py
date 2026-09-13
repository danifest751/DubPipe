#!/usr/bin/env python3
"""
Проверка корректности спектральной обработки стадии S4.

Убеждается, что STFT обратим: прямое и обратное преобразование должны
восстанавливать сигнал с точностью до машинного эпсилон float32. Ошибка здесь
означает искажение фонограммы после разделения.

Запуск: python scripts/check-separation.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
from mdx_separate import CHUNK, DIM_T, N_BINS, istft, stft  # noqa: E402

rng = np.random.default_rng(42)
signal = rng.standard_normal((2, CHUNK)).astype(np.float32) * 0.3

spec = stft(signal)
assert spec.shape == (2, N_BINS, DIM_T), f"unexpected spectrum shape {spec.shape}"

restored = istft(spec, CHUNK)
# Края кадрируются окном, поэтому сравнивается внутренняя часть.
MARGIN = 6144
inner = slice(MARGIN, CHUNK - MARGIN)
error = np.abs(signal[:, inner] - restored[:, inner])

print(f"spectrum shape: {spec.shape}")
print(f"reconstruction error: max {error.max():.2e}, mean {error.mean():.2e}")

if error.max() < 1e-4:
    print("OK: STFT round-trip is exact")
else:
    print("FAIL: STFT round-trip is broken")
    raise SystemExit(1)
