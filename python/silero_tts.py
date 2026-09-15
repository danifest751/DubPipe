"""Синтез русской речи через silero, ТЗ FR-5.

Процесс поднимается один раз и живёт, пока идёт стадия: импорт torch и распаковка
модели стоят пару секунд, а сам синтез реплики — тридцать миллисекунд. Спавнить
процесс на реплику значило бы платить в сто раз больше за подготовку, чем за дело.

Протокол — по строке JSON в каждую сторону:
  на вход   {"text": "...", "voice": "ru_zhadyra", "out": "C:/.../0007.wav", "sample_rate": 48000}
  на выход  {"ok": true, "duration": 1.23}  либо  {"ok": false, "error": "..."}
Первой строкой процесс отвечает {"ready": true, "voices": [...]} — по ней вызывающий
узнаёт, что модель поднялась, и какие дикторы в ней есть.
"""
import argparse
import json
import sys
import warnings

warnings.filterwarnings("ignore")


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="путь к .pt модели silero")
    parser.add_argument("--list", action="store_true", help="напечатать дикторов и выйти")
    args = parser.parse_args()

    try:
        import torch
        import soundfile as sf
    except ImportError as error:
        emit({"ready": False, "error": f"нет модуля: {error.name}"})
        return 3

    try:
        model = torch.package.PackageImporter(args.model).load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
    except Exception as error:  # noqa: BLE001 — причина уходит вызывающему как есть
        emit({"ready": False, "error": f"не удалось открыть модель: {error}"})
        return 4

    voices = [name for name in model.speakers if name.startswith("ru_")]
    emit({"ready": True, "voices": voices})
    if args.list:
        return 0

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            audio = model.apply_tts(
                text=request["text"],
                speaker=request["voice"],
                sample_rate=int(request.get("sample_rate", 48000)),
            )
            rate = int(request.get("sample_rate", 48000))
            # 16 бит — то же, что пишет piper: дальше клип читают наши же утилиты.
            sf.write(request["out"], audio.numpy(), rate, subtype="PCM_16")
            emit({"ok": True, "duration": len(audio) / rate})
        except Exception as error:  # noqa: BLE001
            emit({"ok": False, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
