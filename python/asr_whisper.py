#!/usr/bin/env python3
"""
Распознавание речи через faster-whisper (CTranslate2) — для машины с видеокартой NVIDIA.

Стадия S2 конвейера DubPipe, серверный путь. Локально распознаёт whisper.cpp;
здесь та же модель whisper, но на CUDA и в fp16, и потому large-v3-turbo идёт
быстрее, чем small на процессоре рабочей машины.

Параметры выбраны по тем же граблям, что и у whisper.cpp в src/providers/asr:

* `condition_on_previous_text=False` — модели не подаётся её же прошлый текст.
  С подсказкой одна выдумка тянет следующую: на корейском эпизоде формула из
  титров заняла 68 реплик подряд и вытеснила три с половиной минуты диалога.
  Speaches этот параметр наружу не выставляет, поэтому распознавание идёт здесь.
* VAD выключен — границы реплик уточняет свой silero VAD на стороне конвейера,
  а вырезание тишины до распознавания теряло речь.
* Пословные таймкоды — по выравниванию внимания (DTW), как `-dtw` у whisper.cpp.

Использование:
    python asr_whisper.py --input audio.flac --output asr.json \
        [--model large-v3-turbo] [--language en] [--device auto] [--compute-type float16]
    python asr_whisper.py --probe

Ход работы — строки `progress=NN` в stderr, результат — JSON в --output:
{"language", "duration", "words": [{"word", "start", "end", "probability"}],
 "segments": [{"start", "end", "text"}]}.
"""
import argparse
import json
import os
import sys

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")


def fail(message, code=2):
    print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr, flush=True)
    raise SystemExit(code)


def note(message):
    print(message, file=sys.stderr, flush=True)


#: Короткие имена, как в настройках конвейера, → репозитории CTranslate2 на
#: Hugging Face. Всё прочее передаётся как есть: имя репозитория или путь.
MODELS = {
    "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
    "turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "medium": "Systran/faster-whisper-medium",
    "small": "Systran/faster-whisper-small",
    "base": "Systran/faster-whisper-base",
    "tiny": "Systran/faster-whisper-tiny",
}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--language", default=None)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--cache-dir")
    parser.add_argument("--probe", action="store_true")
    return parser.parse_args()


def preload_cuda_libraries():
    """
    Библиотеки CUDA из пакетов pip (nvidia-cublas, nvidia-cudnn) лежат в
    site-packages, и CTranslate2 их сам не находит. torch, собранный под ту же
    CUDA, при импорте подгружает их в процесс — после этого находятся и у
    CTranslate2. Без torch остаётся надеяться на системные библиотеки.
    """
    try:
        import torch  # noqa: F401

        return torch.cuda.is_available()
    except Exception:  # noqa: BLE001 — нет torch — нет и подсказки, работаем как есть
        return None


def main():
    args = parse_args()
    if args.cache_dir:
        os.makedirs(args.cache_dir, exist_ok=True)
        os.environ.setdefault("HF_HOME", args.cache_dir)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        fail(f"не установлен faster-whisper: {error}")

    if args.probe:
        import importlib.metadata

        print(json.dumps({"ok": True, "faster_whisper": importlib.metadata.version("faster-whisper")}))
        return

    if not args.input or not args.output:
        fail("нужны --input и --output")

    cuda = preload_cuda_libraries()
    device = args.device
    if device in ("auto", "gpu", "dgpu", "cuda"):
        device = "cuda" if cuda is not False else "cpu"
    elif device != "cpu":
        device = "cpu"
    compute_type = args.compute_type
    if compute_type == "auto":
        # Turing умеет fp16 на тензорных ядрах, а bf16 — нет.
        compute_type = "float16" if device == "cuda" else "int8"

    model_id = MODELS.get(args.model, args.model)
    note(f"модель {model_id}, устройство {device}, вычисления {compute_type}")
    print("progress=1", file=sys.stderr, flush=True)
    try:
        model = WhisperModel(model_id, device=device, compute_type=compute_type, download_root=None)
    except Exception as error:  # noqa: BLE001 — причина должна дойти до человека словами
        if device == "cuda":
            note(f"видеокарта не взяла модель ({type(error).__name__}: {str(error)[:120]}); считаю на процессоре")
            model = WhisperModel(model_id, device="cpu", compute_type="int8")
            device = "cpu"
        else:
            fail(f"не удалось загрузить модель {model_id}: {error}")

    segments, info = model.transcribe(
        args.input,
        language=args.language or None,
        beam_size=args.beam_size,
        word_timestamps=True,
        condition_on_previous_text=False,
        vad_filter=False,
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    )
    duration = float(info.duration or 0.0)

    words = []
    lines = []
    last = -1
    for segment in segments:
        lines.append({"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()})
        for word in segment.words or []:
            words.append(
                {
                    "word": word.word,
                    "start": round(float(word.start), 3),
                    "end": round(float(word.end), 3),
                    "probability": round(float(word.probability), 4),
                }
            )
        if duration > 0:
            percent = max(1, min(99, int(segment.end / duration * 100)))
            if percent != last:
                last = percent
                print(f"progress={percent}", file=sys.stderr, flush=True)

    result = {
        "language": info.language,
        "duration": duration,
        "model": model_id,
        "device": device,
        "words": words,
        "segments": lines,
    }
    temporary = f"{args.output}.partial"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False)
    os.replace(temporary, args.output)
    print("progress=100", file=sys.stderr, flush=True)
    print(json.dumps({"words": len(words), "segments": len(lines), "device": device}))


if __name__ == "__main__":
    main()
