# syntax=docker/dockerfile:1
#
# dubpipe-worker — сервис DubPipe на машине с видеокартой NVIDIA, в контейнере.
#
# То же, что ставит scripts/server/install-worker.sh --with-clone, но одной
# сборкой и с точными версиями пакетов (worker.lock.txt, xvoice.lock.txt —
# сняты с работающего сервера). Сборка — из корня репозитория:
#
#   docker compose -f docker/worker/compose.yaml up -d --build
#
# Весов в образе нет: они большие, а у X-Voice ещё и некоммерческая лицензия.
# Сервис качает их сам при первом обращении, X-Voice — при первом запуске
# контейнера; всё ложится на том /data и переживает пересборку.
#
# Драйвер NVIDIA — на машине-хозяине, библиотеки CUDA — из пакетов pip
# (nvidia-*), поэтому основа образа — обычная Ubuntu, а не образ CUDA.

FROM ubuntu:24.04 AS build

ARG TORCH_INDEX=https://download.pytorch.org/whl/cu128
# Проверенные версии: X-Voice и espeak-ng, под который собран его словарь фонем.
ARG XVOICE_COMMIT=817bcdd
ARG ESPEAK_COMMIT=b0b605c8a80f76c4c19e18033c6780c3cc4afc5b

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git build-essential cmake \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /usr/local/bin/uv
RUN uv python install 3.12 3.11

# Окружение сервиса: torch под CUDA 12.8, pyannote, faster-whisper, onnxruntime-gpu.
COPY docker/worker/worker.lock.txt /tmp/worker.lock.txt
RUN uv venv -q -p 3.12 /opt/dubpipe/.venv \
 && uv pip install -q --python /opt/dubpipe/.venv/bin/python --no-deps \
      --index-url https://pypi.org/simple --extra-index-url "$TORCH_INDEX" --index-strategy unsafe-best-match \
      -r /tmp/worker.lock.txt

# Голоса актёров: X-Voice в своём окружении — его CTranslate2 4.5 и torch 2.8
# несовместимы с окружением сервиса.
RUN git clone -q --recursive https://github.com/sunnyxrxrx/X-Voice.git /opt/xvoice/X-Voice \
 && git -C /opt/xvoice/X-Voice checkout -q "$XVOICE_COMMIT" \
 && git -C /opt/xvoice/X-Voice submodule update -q --init --recursive
COPY docker/worker/xvoice.lock.txt /tmp/xvoice.lock.txt
RUN uv venv -q -p 3.11 /opt/xvoice/.venv \
 && uv pip install -q --python /opt/xvoice/.venv/bin/python --no-deps \
      --index-url https://pypi.org/simple --extra-index-url "$TORCH_INDEX" --index-strategy unsafe-best-match \
      -r /tmp/xvoice.lock.txt \
 && uv pip install -q --python /opt/xvoice/.venv/bin/python --no-deps -e /opt/xvoice/X-Voice

# espeak-ng — рядом с X-Voice, а не в /usr: его скрипт установки стирает
# системные библиотеки, а нужна только своя.
RUN git clone -q https://github.com/espeak-ng/espeak-ng.git /tmp/espeak \
 && git -C /tmp/espeak checkout -q --detach "$ESPEAK_COMMIT" \
 && cmake -S /tmp/espeak -B /tmp/espeak-build -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/xvoice/espeak -DBUILD_SHARED_LIBS=ON -DENABLE_TESTS=OFF > /tmp/espeak.log \
 && cmake --build /tmp/espeak-build -j"$(nproc)" >> /tmp/espeak.log \
 && cmake --install /tmp/espeak-build >> /tmp/espeak.log \
 && rm -rf /tmp/espeak /tmp/espeak-build

# Проверка сборки без видеокарты: модули на месте и импортируются.
RUN /opt/dubpipe/.venv/bin/python -c "import torch, onnxruntime, ctranslate2, faster_whisper, pyannote.audio; print('сервис:', torch.__version__)" \
 && /opt/xvoice/.venv/bin/python -c "import importlib.util, torch; assert importlib.util.find_spec('x_voice'); print('X-Voice:', torch.__version__)" \
 && test -f /opt/xvoice/espeak/lib/libespeak-ng.so

# Двенадцать пакетов CUDA (cuBLAS, cuFFT, cuSPARSE…) в обоих окружениях одних
# версий — хранить их дважды незачем: одинаковые файлы становятся жёсткими
# ссылками (минус 3 ГБ). В образ они переносятся одним слоем через cp -a.
RUN hardlink -q --ignore-time /opt/dubpipe/.venv /opt/xvoice/.venv


FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libgomp1 tzdata \
 && rm -rf /var/lib/apt/lists/*
# tzdata — база часовых поясов: без неё X-Voice падает при загрузке
# (ZoneInfoNotFoundError в нормализаторе текста).

# cp -a, а не COPY --from: COPY превращает жёсткие ссылки обратно в копии.
RUN --mount=type=bind,from=build,source=/opt,target=/mnt/build cp -a /mnt/build/. /opt/
COPY python/*.py /opt/dubpipe/
COPY docker/worker/entrypoint.sh /usr/local/bin/dubpipe-worker

# Всё, что качается и копится, — на томе /data: веса X-Voice (HF_HOME сервиса
# для X-Voice — /opt/xvoice/hf), вокодер (X-Voice ищет его по относительному
# пути my_vocoder/), модель языков fastlid (~/.cache).
RUN rm -rf /opt/xvoice/hf /opt/xvoice/X-Voice/my_vocoder \
 && ln -s /data/xvoice/hf /opt/xvoice/hf \
 && ln -s /data/xvoice/my_vocoder /opt/xvoice/X-Voice/my_vocoder \
 && chmod +x /usr/local/bin/dubpipe-worker

ENV HOME=/data/home \
    PYTHONUNBUFFERED=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    DUBPIPE_CLONE=1

VOLUME /data
EXPOSE 8770
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m \
  CMD curl -fsS http://127.0.0.1:8770/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/dubpipe-worker"]
