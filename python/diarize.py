#!/usr/bin/env python3
"""
Диаризация спикеров моделью pyannote (PyTorch, CPU).

Стадия S2 конвейера DubPipe. ТЗ §FR-2 разрешает внешний Python-процесс именно
для диаризации: у whisper.cpp нет разделения по говорящим, а pyannote — де-факто
стандарт, но живёт только в PyTorch.

Использование:
    python diarize.py --input audio16k.wav --output diarization.json \
        [--model pyannote/speaker-diarization-community-1] [--max-speakers 4] \
        [--cache-dir .dubpipe/models/hf] [--token-env HF_TOKEN] [--offline]
    python diarize.py --warmup [...]   # только загрузить веса, ничего не считать
    python diarize.py --probe          # проверить, что pyannote импортируется

Токен Hugging Face берётся из переменной окружения (по умолчанию HF_TOKEN),
в аргументах командной строки он не появляется — иначе попал бы в журналы.
Веса кладутся в --cache-dir; после первой загрузки работа идёт офлайн.

Ход работы печатается в stderr строками вида `progress=NN`, результат — JSON
в stdout: {"turns": [{"start", "end", "speaker"}], "speakers": N}.
"""
import argparse
import json
import os
import sys
import wave

# Node читает потоки как UTF-8; без этого русские сообщения об ошибках
# приходят в кодировке консоли Windows и превращаются в кракозябры.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")


def fail(message, code=2):
    print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--model", default="pyannote/speaker-diarization-community-1")
    parser.add_argument("--max-speakers", type=int, default=0)
    parser.add_argument("--cache-dir")
    parser.add_argument("--token-env", default="HF_TOKEN")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--warmup", action="store_true")
    parser.add_argument("--probe", action="store_true")
    return parser.parse_args()


def configure_environment(args):
    # Кэш весов — внутри рабочего каталога программы, а не в профиле пользователя:
    # так его видно в «Окружении» и он удаляется вместе с остальными моделями.
    if args.cache_dir:
        os.makedirs(args.cache_dir, exist_ok=True)
        os.environ["HF_HOME"] = args.cache_dir
        os.environ["HF_HUB_CACHE"] = os.path.join(args.cache_dir, "hub")
    if args.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
    # Телеметрию и напоминания об обновлениях — выключить: работаем офлайн.
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("PYANNOTE_DATABASE_CONFIG", "")


def load_pipeline(args):
    try:
        import torch
        from pyannote.audio import Pipeline
    except ImportError as error:
        fail(f"не установлен pyannote.audio: {error}")

    token = os.environ.get(args.token_env) or None
    kwargs = {"cache_dir": os.path.join(args.cache_dir, "hub")} if args.cache_dir else {}
    try:
        try:
            pipeline = Pipeline.from_pretrained(args.model, token=token, **kwargs)
        except TypeError:
            # pyannote.audio < 3.3 знает только старое имя аргумента.
            pipeline = Pipeline.from_pretrained(args.model, use_auth_token=token, **kwargs)
    except Exception as error:  # noqa: BLE001 — любая причина должна дойти до пользователя словами
        text = str(error)
        if "401" in text or "403" in text or "gated" in text.lower() or "restricted" in text.lower():
            fail(
                "нет доступа к весам модели: примите условия использования на странице "
                f"https://huggingface.co/{args.model} (и на страницах моделей, которые она использует), "
                f"а токен в {args.token_env} должен иметь право чтения gated-репозиториев"
            )
        if "offline" in text.lower() or "connection" in text.lower() or "resolve" in text.lower():
            fail("веса модели не загружены, а сети нет: нажмите «Догрузить недостающее» при подключении")
        fail(f"не удалось загрузить модель {args.model}: {text.splitlines()[-1] if text else type(error).__name__}")

    if pipeline is None:
        fail(
            "модель не отдана хабом (обычно — не приняты условия использования): "
            f"откройте https://huggingface.co/{args.model} и нажмите «Agree»"
        )

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    return pipeline, torch


def read_wav(path):
    """Читает WAV 16 бит моно и возвращает (float32 [1, N], частота)."""
    import numpy as np

    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        fail(f"поддерживается только 16-битный PCM, получено {width * 8} бит")
    data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data.reshape(1, -1), rate


class ProgressHook:
    """Печатает ход по этапам пайплайна; сегментация и эмбеддинги — самые долгие."""

    STEPS = {"segmentation": (5, 55), "embeddings": (55, 95)}

    def __init__(self):
        self.last = -1

    def __call__(self, step_name, step_artifact, file=None, total=None, completed=None):
        span = self.STEPS.get(step_name)
        if span is None or not total:
            return
        low, high = span
        percent = int(low + (high - low) * (completed or 0) / total)
        if percent != self.last:
            self.last = percent
            print(f"progress={percent}", file=sys.stderr, flush=True)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def main():
    args = parse_args()
    configure_environment(args)

    if args.probe:
        # Только проверка наличия модулей: импорт torch занимает секунды,
        # а проверка готовности вызывается интерфейсом часто.
        import importlib.metadata
        import importlib.util

        missing = [name for name in ("pyannote.audio", "torch") if importlib.util.find_spec(name) is None]
        if missing:
            fail(f"не установлены модули: {', '.join(missing)}")
        try:
            version = importlib.metadata.version("pyannote.audio")
        except importlib.metadata.PackageNotFoundError:
            version = "?"
        print(json.dumps({"ok": True, "pyannote": version}))
        return

    pipeline, torch = load_pipeline(args)
    if args.warmup:
        print(json.dumps({"ok": True, "model": args.model}))
        return

    if not args.input or not args.output:
        fail("нужны --input и --output")

    waveform, rate = read_wav(args.input)
    audio = {"waveform": torch.from_numpy(waveform), "sample_rate": rate}
    options = {}
    if args.max_speakers > 0:
        options["max_speakers"] = args.max_speakers

    print("progress=5", file=sys.stderr, flush=True)
    with ProgressHook() as hook:
        try:
            annotation = pipeline(audio, hook=hook, **options)
        except TypeError:
            annotation = pipeline(audio, **options)
    # pyannote 4.x возвращает объект с полем speaker_diarization.
    annotation = getattr(annotation, "speaker_diarization", annotation)

    turns = []
    speakers = []
    for turn, _, label in annotation.itertracks(yield_label=True):
        if label not in speakers:
            speakers.append(label)
        turns.append({"start": round(float(turn.start), 3), "end": round(float(turn.end), 3), "speaker": label})
    turns.sort(key=lambda item: item["start"])

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump({"turns": turns, "speakers": len(speakers)}, handle, ensure_ascii=False, indent=1)
    print("progress=100", file=sys.stderr, flush=True)
    print(json.dumps({"turns": len(turns), "speakers": len(speakers)}))


if __name__ == "__main__":
    main()
