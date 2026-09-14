#!/usr/bin/env python3
"""
Выбор устройства для python-модулей конвейера.

Правило одно на все стадии и получено замерами, а не из общих соображений:
**тяжёлую сеть выгодно считать на видеокарте, лёгкую обработку сигнала — нет.**

На Radeon 780M, onnxruntime, один и тот же звук:

| что считаем                      | процессор | DirectML |
|----------------------------------|-----------|----------|
| отделение голоса (MDX-Net)       |   1.65 с  |  0.31 с  |
| голосовые отпечатки (ResNet34)   |   1.13 с  |  0.20 с  |
| сегментация речи (pyannote)      |   0.22 с  |  2.50 с  |

Последняя строка и есть причина, по которой выбор не делается одной галочкой
«всё на видеокарту»: сеть сегментации крошечная, и пересылка данных туда-обратно
стоит дороже, чем сами вычисления. Поэтому устройство выбирается для каждой
стадии отдельно, а модули, которым видеокарта не нужна, её не просят.
"""
import sys

#: Значения настройки устройства. `igpu` и `dgpu` различают встроенную и
#: отдельную видеокарты на машинах, где есть обе; `cuda` — привычное имя для
#: «считать на видеокарте», оставленное потому, что torch показывает через тот
#: же интерфейс и ROCm у AMD.
DEVICE_CHOICES = ("auto", "cpu", "gpu", "igpu", "dgpu", "cuda")

GPU_CHOICES = ("auto", "gpu", "igpu", "dgpu", "cuda")


def note(message):
    """Строка для журнала прогона: TS-сторона пишет такие в отладочный вывод."""
    print(message, file=sys.stderr, flush=True)


def onnx_providers(preference):
    """
    Исполнители onnxruntime под выбранное устройство, в порядке предпочтения.

    Список всегда заканчивается процессором: если видеокарта занята, отсутствует
    или её драйвер отказал, onnxruntime молча возьмёт следующий по списку, и
    прогон не прервётся.
    """
    import onnxruntime as ort

    available = list(ort.get_available_providers())
    order = []
    if preference in GPU_CHOICES:
        # DirectML работает на любой видеокарте с DirectX 12 — и на встроенной
        # тоже; CUDA и ROCm подхватываются, если onnxruntime собран с ними.
        for name in ("DmlExecutionProvider", "CUDAExecutionProvider", "ROCMExecutionProvider"):
            if name in available:
                order.append(name)
    order.append("CPUExecutionProvider")
    return order


def onnx_session(model_path, preference, options=None, label=""):
    """
    Сессия onnxruntime на выбранном устройстве, с откатом на процессор.

    Неудача при создании сессии на видеокарте — не повод останавливать прогон:
    стадия важнее ускорения.
    """
    import onnxruntime as ort

    providers = onnx_providers(preference)
    try:
        session = ort.InferenceSession(model_path, options, providers=providers)
    except Exception as error:  # noqa: BLE001 — причина в журнал, считаем на процессоре
        if providers == ["CPUExecutionProvider"]:
            raise
        note(f"{label}видеокарта недоступна ({type(error).__name__}: {str(error)[:70]}); считаю на процессоре")
        session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])
    note(f"{label}исполнитель: {session.get_providers()[0]}")
    return session

# Ниже — тот же выбор устройства, но для torch. Он нужен отдельно от
# onnxruntime: у каждого свой список устройств, и сопоставить их по номеру
# нельзя — torch видит только карты своего производителя, а onnxruntime через
# DirectML видит любые. Правило «встроенная или отдельная» повторяет
# `gpuKind` из src/providers/asr/accel.ts: там классифицируются адаптеры,
# которые называет Windows, здесь — те, что называет torch.

DISCRETE_MARKERS = ("rtx", "gtx", "geforce", "quadro", "tesla", "radeon pro", " rx ")
INTEGRATED_MARKERS = ("graphics", "uhd", "iris", "vega", "apple m")


def gpu_kind(name):
    """Встроенная видеокарта или отдельная — по названию, как его отдаёт torch."""
    text = f" {name.lower()} "
    if any(marker in text for marker in DISCRETE_MARKERS):
        return "discrete"
    # «Radeon 780M Graphics», «Intel UHD Graphics» — графика внутри процессора.
    if any(marker in text for marker in INTEGRATED_MARKERS):
        return "integrated"
    return "discrete"


def pick_torch_gpu(torch, preference):
    """
    Номер видеокарты для расчёта или None, если считать на процессоре.

    Выбор мягкий: нет подходящего устройства — работаем на процессоре и
    говорим об этом. Прогон важнее, чем настройка, которую нельзя выполнить.
    """
    if preference == "cpu":
        return None
    if not torch.cuda.is_available():
        if preference != "auto":
            note("видеокарта недоступна для torch, считаю на процессоре")
        return None

    names = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
    if not names:
        return None
    if preference == "auto" and getattr(torch.version, "hip", None):
        # ROCm под Windows пока незрелый: MIOpen роняет часть операций, а обход
        # отключает его ядра, и выигрыш падает до 1.2 раза (1 мин 41 с против
        # 2 мин 02 с на пяти минутах записи). Двадцать процентов не стоят риска
        # уронить работающий прогон, поэтому сам он видеокарту AMD не берёт —
        # только по прямому указанию. С CUDA выигрыш совсем другого порядка.
        note("видеокарта AMD (ROCm) сама не выбирается: укажите device явно")
        return None
    if preference in ("auto", "gpu", "cuda"):
        # При выборе «просто видеокарта» отдельная предпочтительнее встроенной:
        # у встроенной память общая с процессором и полоса у́же.
        for index, name in enumerate(names):
            if gpu_kind(name) == "discrete":
                return index
        return 0

    wanted = "integrated" if preference == "igpu" else "discrete"
    for index, name in enumerate(names):
        if gpu_kind(name) == wanted:
            return index
    note(f"подходящей видеокарты ({preference}) нет среди: {', '.join(names)}; беру первую")
    return 0
