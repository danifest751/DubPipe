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

from compute import DEVICE_CHOICES, note, onnx_session, pick_torch_gpu

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
    # auto — видеокарта, если она есть и её видит torch; иначе процессор.
    parser.add_argument("--device", default="auto", choices=DEVICE_CHOICES)
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

    # Почти вся диаризация — это сеть голосовых отпечатков: 105 секунд из 108
    # на пятиминутном отрезке. Её и переносим на видеокарту, через onnxruntime:
    # 0.20 с на пакет против 1.89 с у torch. Остальные шаги трогать не надо —
    # сеть сегментации крошечная, и на видеокарте она вдесятеро медленнее, чем
    # на процессоре, из-за пересылок.
    if args.device != "cpu" and use_onnx_embedding(pipeline, args.cache_dir, args.device, torch):
        note(f"остальные шаги: процессор, потоков {max(1, os.cpu_count() or 1)}")
        return pipeline, torch

    # Запасной путь: считать всё сетями torch, по возможности на видеокарте.
    index = pick_torch_gpu(torch, args.device)
    if index is None:
        note(f"устройство: процессор, потоков {max(1, os.cpu_count() or 1)}")
        return pipeline, torch
    if getattr(torch.version, "hip", None) and not miopen_works(torch):
        # Без MIOpen свёртки считаются обычными ядрами torch: медленнее, но
        # работает. На Radeon 780M это 1 мин 41 с против 2 мин 02 на процессоре.
        note("MIOpen не собирает ядра, считаю без него")
        torch.backends.cudnn.enabled = False
    try:
        pipeline.to(torch.device(f"cuda:{index}"))
        note(f"устройство: {torch.cuda.get_device_name(index)}")
    except Exception as error:  # noqa: BLE001 — откат на процессор важнее причины
        note(f"не удалось занять видеокарту ({error}); считаю на процессоре")
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


EMBEDDING_ONNX = "embedding-wespeaker-resnet34.onnx"


def export_embedding_onnx(model, path, torch):
    """
    Выгружает сеть голосовых отпечатков в ONNX. Делается один раз: файл
    остаётся рядом с весами и переиспользуется всеми последующими прогонами.

    Выгружается только сеть, без подготовки признаков: та использует
    `torch.vmap`, который в ONNX не переводится, а стоит она копейки — 0.07 с
    на пакет против 1.9 с у самой сети.
    """

    class Wrapper(torch.nn.Module):
        def __init__(self, resnet):
            super().__init__()
            self.resnet = resnet

        def forward(self, fbank, weights):
            return self.resnet(fbank, weights=weights)[1]

    with torch.no_grad():
        sample = model.compute_fbank(torch.randn(2, 1, 16000 * 5))
        weights = torch.rand(sample.shape[0], sample.shape[1])
    temporary = f"{path}.partial"
    torch.onnx.export(
        Wrapper(model.resnet).eval(),
        (sample, weights),
        temporary,
        input_names=["fbank", "weights"],
        output_names=["embedding"],
        dynamic_axes={
            "fbank": {0: "batch", 1: "frames"},
            "weights": {0: "batch", 1: "frames"},
            "embedding": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    os.replace(temporary, path)


def use_onnx_embedding(pipeline, cache_dir, device, torch):
    """
    Переводит шаг голосовых отпечатков на onnxruntime.

    Именно он занимает 96% времени диаризации — 105 секунд из 108 на пятиминутном
    отрезке, — а всё остальное pyannote делает быстро и остаётся как есть.

    Любая неудача здесь не беда: возвращаем False, и прогон идёт прежним путём.
    """
    try:
        from pyannote.audio.pipelines.speaker_verification import (
            PyannoteAudioPretrainedSpeakerEmbedding,
        )

        holder = pipeline._embedding
        model = holder.model_
        path = os.path.join(cache_dir, EMBEDDING_ONNX)
        if not os.path.exists(path):
            note("выгружаю сеть отпечатков в ONNX (один раз)")
            export_embedding_onnx(model, path, torch)
        # DirectML выгоден именно на этой сети: 0.20 с на пакет против 1.13 с
        # у onnxruntime на процессоре и 1.89 с у torch.
        session = onnx_session(path, device, label="отпечатки голосов: ")

        if not getattr(PyannoteAudioPretrainedSpeakerEmbedding, "_dubpipe_patched", False):
            original = PyannoteAudioPretrainedSpeakerEmbedding.__call__

            def call(self, waveforms, masks=None):
                run = getattr(self, "_dubpipe_session", None)
                if run is None:
                    return original(self, waveforms, masks)
                with torch.inference_mode():
                    fbank = self.model_.compute_fbank(waveforms.to("cpu"))
                if masks is None:
                    weights = torch.ones(fbank.shape[0], fbank.shape[1])
                else:
                    weights = masks.detach().to("cpu").float()
                return run.run(None, {"fbank": fbank.numpy(), "weights": weights.numpy()})[0]

            PyannoteAudioPretrainedSpeakerEmbedding.__call__ = call
            PyannoteAudioPretrainedSpeakerEmbedding._dubpipe_patched = True

        holder._dubpipe_session = session
        return True
    except Exception as error:  # noqa: BLE001 — причина в журнал, прогон продолжается
        note(f"ONNX для отпечатков не задействован ({type(error).__name__}: {str(error)[:70]})")
        return False


def miopen_works(torch):
    """
    Способен ли MIOpen собрать хоть одно ядро.

    Он компилирует их на лету, а в пакетах ROCm под Windows нет стандартных
    заголовков C++ — сборка падает на любом ядре: мы видели это и на
    нормализации (ROCm#6150), и на обновлении состояния RNN. Выяснить это одной
    маленькой операцией дешевле, чем уронить расчёт на середине и повторить его.
    """
    try:
        x = torch.randn(2, 4, 8, device="cuda")
        weight = torch.ones(4, device="cuda")
        bias = torch.zeros(4, device="cuda")
        torch.nn.functional.batch_norm(x, None, None, weight, bias, True, 0.1, 1e-5)
        torch.cuda.synchronize()
        return True
    except Exception:  # noqa: BLE001 — причина не важна, важен факт
        return False


def patch_instance_norm(torch):
    """
    Считает нормализацию своими средствами вместо ядра MIOpen.

    Ломается именно оно: MIOpen собирает MIOpenBatchNormFwdTrainSpatial на лету,
    и под Windows сборка падает — в пакетах ROCm нет стандартных заголовков C++
    (ROCm#6150, воспроизводится и на поддерживаемой RX 9060 XT). На Linux то же
    ядро падает на ассемблерной вставке (TheRock#2488). А свёртки — основная
    работа сети — считаются MIOpen нормально, поэтому глушить его целиком
    значит терять их скорость ради одной сломанной операции.

    Формула нормализации простая, и обычные операции torch дают тот же
    результат: вычесть среднее по времени, поделить на разброс, применить
    обучаемые коэффициенты.
    """
    from torch.nn.modules.instancenorm import _InstanceNorm

    if getattr(_InstanceNorm, "_dubpipe_patched", False):
        return
    original = _InstanceNorm.forward

    def forward(self, input):
        # Скользящие средние здесь не используются; если они включены,
        # поведение сложнее, и мы не вмешиваемся.
        if self.track_running_stats or input.device.type != "cuda":
            return original(self, input)
        channel_dim = 1 if input.dim() > 2 else 0
        spatial = tuple(range(channel_dim + 1, input.dim()))
        mean = input.mean(dim=spatial, keepdim=True)
        variance = input.var(dim=spatial, keepdim=True, unbiased=False)
        output = (input - mean) * torch.rsqrt(variance + self.eps)
        if self.affine:
            shape = [1] * input.dim()
            shape[channel_dim] = -1
            output = output * self.weight.view(shape) + self.bias.view(shape)
        return output

    _InstanceNorm.forward = forward
    _InstanceNorm._dubpipe_patched = True


def run_pipeline(pipeline, audio, options):
    """Один прогон диаризации с показом хода работы."""
    with ProgressHook() as hook:
        try:
            return pipeline(audio, hook=hook, **options)
        except TypeError:
            return pipeline(audio, **options)


def on_gpu(pipeline, torch):
    """Считает ли конвейер на видеокарте — по устройству первого же параметра."""
    device = getattr(pipeline, "device", None)
    if device is not None:
        return getattr(device, "type", "cpu") != "cpu"
    return torch.cuda.is_available()


def diarize_with_fallback(pipeline, audio, options, torch):
    """
    Считает диаризацию, спускаясь по ступеням при неудаче.

    У ROCm под Windows собраны не все ядра, и заранее не известно, на какой
    операции это вылезет. Ступени идут от быстрого к надёжному: видеокарта как
    есть, видеокарта без ускоренных ядер MIOpen, процессор. Прогон дороже
    ускорения, поэтому сдаёмся только на последней.
    """
    if not on_gpu(pipeline, torch):
        return run_pipeline(pipeline, audio, options)

    steps = ("видеокарта", "видеокарта без MIOpen", "процессор")
    for step in steps:
        if step == "видеокарта без MIOpen":
            torch.backends.cudnn.enabled = False
        elif step == "процессор":
            pipeline.to(torch.device("cpu"))
        try:
            return run_pipeline(pipeline, audio, options)
        except Exception as error:  # noqa: BLE001 — на видеокарте падает что угодно
            if step == steps[-1]:
                raise
            note(f"{step}: не вышло ({type(error).__name__}: {str(error)[:70]}); пробую дальше")
    raise RuntimeError("диаризация не выполнена ни на одной ступени")


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
    annotation = diarize_with_fallback(pipeline, audio, options, torch)
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
