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
