"""Синтез русской речи через silero, ТЗ FR-5.

Процесс поднимается один раз и живёт, пока идёт стадия: импорт torch и распаковка
модели стоят пару секунд, а сам синтез реплики — тридцать миллисекунд. Спавнить
процесс на реплику значило бы платить в сто раз больше за подготовку, чем за дело.

Моделей у движка несколько: в одной 29 дикторов народов СНГ, читающих по-русски,
в другой пять носителей без акцента. Держать обе поднятыми незачем — та, что не
нужна этому фильму, не должна ни качаться, ни занимать память, — поэтому модели
подгружаются по требованию, командой `load`.

Протокол — по строке JSON в каждую сторону:
  на вход   {"load": "v5_5_ru", "path": "C:/.../v5_5_ru.pt", "mode": "prefix"}
            {"text": "...", "voice": "ru_baya", "out": "C:/.../0007.wav", "sample_rate": 48000}
  на выход  {"ok": true, "voices": [...]}  либо  {"ok": true, "duration": 1.23}
            либо  {"ok": false, "error": "..."}
Первой строкой процесс отвечает {"ready": true, "voices": [...]} — по ней вызывающий
узнаёт, что torch поднялся, и какие дикторы уже доступны.

Имена дикторов у моделей разные по виду: в одной `ru_zhadyra`, в другой `baya`.
Наружу они уходят единообразно, с приставкой `ru_`, потому что этими именами
пользуется весь остальной проект — настройки, правки видео, отпечатки клипов.
"""
import argparse
import json
import sys
import warnings

warnings.filterwarnings("ignore")


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def russian(model, mode):
    """Русские дикторы модели: имя наружу -> имя внутри.

    Моделей две, и устроены они по-разному. В модели СНГ рядом с русскими
    дикторами живут башкирские, татарские, эрзянские — те читают на своих
    языках, и русскому дубляжу не годятся; отбираются только `ru_*`. В модели
    носителей дикторов пятеро, и приставки у них нет вовсе — им её добавляем,
    потому что этими именами пользуется весь остальной проект.
    """
    pairs = {}
    for speaker in model.speakers:
        if speaker == "random":
            continue
        if mode == "prefix":
            pairs[f"ru_{speaker}"] = speaker
        elif speaker.startswith("ru_"):
            pairs[speaker] = speaker
    return pairs


class Voices:
    """Поднятые модели и дикторы в них: имя наружу -> (модель, имя внутри)."""

    def __init__(self):
        self.models = {}
        self.speakers = {}

    def load(self, tag, path, mode="ru"):
        import torch

        if tag in self.models:
            return [name for name, (owner, _) in self.speakers.items() if owner == tag]
        model = torch.package.PackageImporter(path).load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
        self.models[tag] = model
        added = []
        for name, speaker in russian(model, mode).items():
            # Первая модель, объявившая имя, его и держит: молчаливая подмена
            # диктора звучала бы как чужой голос в уже сведённом фильме.
            if name in self.speakers:
                continue
            self.speakers[name] = (tag, speaker)
            added.append(name)
        return added

    def say(self, request):
        name = request["voice"]
        found = self.speakers.get(name)
        if found is None:
            raise KeyError(f"диктора «{name}» нет в поднятых моделях")
        tag, speaker = found
        rate = int(request.get("sample_rate", 48000))
        try:
            audio = self.models[tag].apply_tts(text=request["text"], speaker=speaker, sample_rate=rate)
        except ValueError as error:
            # Русская модель выбрасывает незнакомые символы, и на тексте из одной
            # латиницы ей нечего произнести. Ошибка приходит пустой: «ValueError: »
            # — по такой не понять ничего, а стадия на ней встаёт.
            raise ValueError(str(error) or f"нечего произносить: {request['text'][:60]!r}") from None
        return audio, rate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model",
        action="append",
        default=[],
        metavar="ТЕГ=ПУТЬ[#РЕЖИМ]",
        help="модель silero; можно указать несколько, остальные подгрузятся по требованию",
    )
    parser.add_argument("--list", action="store_true", help="напечатать дикторов и выйти")
    args = parser.parse_args()

    try:
        import torch  # noqa: F401 — проверяем, что зависимости на месте
        import soundfile as sf
    except ImportError as error:
        emit({"ready": False, "error": f"нет модуля: {error.name}"})
        return 3

    voices = Voices()
    try:
        for item in args.model:
            tag, _, rest = item.partition("=")
            path, _, mode = rest.partition("#")
            voices.load(tag or "model", path or tag, mode or "ru")
    except Exception as error:  # noqa: BLE001 — причина уходит вызывающему как есть
        emit({"ready": False, "error": f"не удалось открыть модель: {error}"})
        return 4

    emit({"ready": True, "voices": sorted(voices.speakers)})
    if args.list:
        return 0

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if "load" in request:
                added = voices.load(request["load"], request["path"], request.get("mode", "ru"))
                emit({"ok": True, "voices": added})
                continue
            audio, rate = voices.say(request)
            # 16 бит — то же, что пишет piper: дальше клип читают наши же утилиты.
            sf.write(request["out"], audio.numpy(), rate, subtype="PCM_16")
            emit({"ok": True, "duration": len(audio) / rate})
        except Exception as error:  # noqa: BLE001
            emit({"ok": False, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
