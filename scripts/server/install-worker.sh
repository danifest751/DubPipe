#!/usr/bin/env bash
# Установка dubpipe-worker — сервиса DubPipe на машине с видеокартой NVIDIA (Linux).
#
# Проще — в Docker: docker compose -f docker/worker/compose.yaml up -d --build
# (docker/worker/Dockerfile, те же шаги и точные версии пакетов). Этот скрипт —
# для установки без Docker.
#
# Запускать на самом сервере, из каталога, куда скопированы скрипты:
#
#   scp -r python scripts/server/install-worker.sh user@server:dubpipe-worker/
#   ssh user@server 'bash dubpipe-worker/install-worker.sh [--with-clone]'
#
# --with-clone — ещё и голоса актёров: X-Voice в собственном окружении
# ($DIR/xvoice). Его зависимости (CTranslate2 4.5, torch 2.8) несовместимы с
# окружением сервиса, поэтому оно отдельное; сервис запускает его мостом.
#
# Что делает: окружение Python с torch под CUDA 12.8, pyannote.audio,
# faster-whisper и onnxruntime-gpu; служба systemd `dubpipe-worker` на порту
# 8770 (нужен sudo; SKIP_SERVICE=1 — не трогать службу). Повторный запуск доустанавливает недостающее и
# перезапускает службу — так же обновляются скрипты.
#
# Почему CUDA 12.8, а не новейшая: CTranslate2 (faster-whisper) и
# onnxruntime-gpu собраны под CUDA 12 и берут cuBLAS и cuDNN из тех же пакетов
# nvidia-*, что и torch. Одна версия библиотек на всех — одно окружение.
set -euo pipefail

DIR="${DUBPIPE_WORKER_DIR:-$HOME/dubpipe-worker}"
PORT="${DUBPIPE_WORKER_PORT:-8770}"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu128}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WITH_CLONE=0
[ "${1:-}" = "--with-clone" ] && WITH_CLONE=1
# Проверенные версии: X-Voice и espeak-ng, под который собран его словарь фонем.
XVOICE_COMMIT="817bcdd"
ESPEAK_COMMIT="b0b605c8a80f76c4c19e18033c6780c3cc4afc5b"

mkdir -p "$DIR"
# Скрипты лежат рядом (python/*.py) или уже в каталоге сервиса.
for source in "$HERE/python" "$HERE/../../python"; do
  if [ -f "$source/dubpipe_worker.py" ]; then
    cp "$source"/*.py "$DIR"/
    break
  fi
done
[ -f "$DIR/dubpipe_worker.py" ] || { echo "нет dubpipe_worker.py ни рядом, ни в $DIR" >&2; exit 1; }
cd "$DIR"

export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null; then
  echo "== ставлю uv (менеджер пакетов Python)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

[ -d .venv ] || uv venv -p 3.12 .venv
# shellcheck disable=SC1091
. .venv/bin/activate

echo "== torch под CUDA"
uv pip install --index-url "$TORCH_INDEX" torch torchaudio
# torch и его библиотеки CUDA закрепляются: иначе следующий шаг может
# заменить их сборкой с PyPI под другую CUDA.
uv pip freeze | grep -iE '^(torch|torchaudio|nvidia-)' > constraints.txt

echo "== pyannote, faster-whisper, onnxruntime-gpu"
uv pip install -c constraints.txt "pyannote.audio>=4" faster-whisper onnxruntime-gpu numpy soundfile
# faster-whisper тянет обычный onnxruntime, и тот затирает GPU-сборку: модуль у
# них общий. Оставляем только GPU-сборку.
uv pip uninstall onnxruntime onnxruntime-gpu >/dev/null 2>&1 || true
uv pip install -c constraints.txt --reinstall-package onnxruntime-gpu onnxruntime-gpu

python - <<'PY'
import torch, onnxruntime as ort, ctranslate2
ort.preload_dlls()
print("torch", torch.__version__, "CUDA:", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
print("onnxruntime", ort.__version__, ort.get_available_providers())
print("ctranslate2 видит карт:", ctranslate2.get_cuda_device_count())
PY

if [ "$WITH_CLONE" = 1 ]; then
  echo "== голоса актёров: X-Voice"
  XV="$DIR/xvoice"
  mkdir -p "$XV"
  [ -d "$XV/X-Voice" ] || git clone -q --recursive https://github.com/sunnyxrxrx/X-Voice.git "$XV/X-Voice"
  git -C "$XV/X-Voice" checkout -q "$XVOICE_COMMIT"
  [ -d "$XV/.venv" ] || uv venv -q -p 3.11 "$XV/.venv"
  XPY="$XV/.venv/bin/python"
  uv pip install -q --python "$XPY" --index-url "$TORCH_INDEX" torch==2.8.0 torchaudio==2.8.0
  uv pip freeze --python "$XPY" | grep -iE '^(torch|torchaudio|nvidia-)' > "$XV/constraints.txt"
  uv pip install -q --python "$XPY" cmake ninja huggingface_hub
  uv pip install -q --python "$XPY" -c "$XV/constraints.txt" -e "$XV/X-Voice"

  # espeak-ng — в каталог сервиса, без sudo: скрипт X-Voice ставит его в /usr
  # и стирает системные библиотеки, а сервису это не нужно.
  if [ ! -f "$XV/espeak/lib/libespeak-ng.so" ]; then
    [ -d "$XV/espeak-src" ] || git clone -q https://github.com/espeak-ng/espeak-ng.git "$XV/espeak-src"
    git -C "$XV/espeak-src" checkout -q --detach "$ESPEAK_COMMIT"
    "$XV/.venv/bin/cmake" -S "$XV/espeak-src" -B "$XV/espeak-build" -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="$XV/espeak" -DBUILD_SHARED_LIBS=ON -DENABLE_TESTS=OFF > "$XV/espeak-build.log"
    "$XV/.venv/bin/cmake" --build "$XV/espeak-build" -j"$(nproc)" >> "$XV/espeak-build.log"
    "$XV/.venv/bin/cmake" --install "$XV/espeak-build" >> "$XV/espeak-build.log"
  fi

  # fastlid при импорте качает модель языков с dl.fbaipublicfiles.com без
  # таймаута; из России загрузка там виснет. Та же модель — с зеркала на HF.
  if [ ! -f "$HOME/.cache/lid.176.ftz" ]; then
    mkdir -p "$HOME/.cache"
    curl -sSL --max-time 120 -o "$HOME/.cache/lid.176.ftz.part" \
      https://huggingface.co/julien-c/fasttext-language-id/resolve/main/lid.176.ftz
    echo "340156704bb8c8e50c4abf35a7ec2569  $HOME/.cache/lid.176.ftz.part" | md5sum -c --quiet
    mv "$HOME/.cache/lid.176.ftz.part" "$HOME/.cache/lid.176.ftz"
  fi

  # Вокодер X-Voice ищет по относительному пути my_vocoder/, веса — в HF_HOME.
  HF_HOME="$XV/hf" "$XPY" - <<PY
from huggingface_hub import hf_hub_download, snapshot_download
snapshot_download("charactr/vocos-mel-24khz", local_dir="$XV/X-Voice/my_vocoder/vocos-mel-24khz")
for name in ("XVoice_Base_Stage1/model_600000.safetensors", "XVoice_Base_Stage1/vocab.txt"):
    hf_hub_download("XRXRX/X-Voice", name)
print("веса X-Voice на месте")
PY
fi

if [ "${SKIP_SERVICE:-0}" = 1 ]; then
  echo "== служба не тронута (SKIP_SERVICE=1): sudo systemctl restart dubpipe-worker"
  exit 0
fi

echo "== служба systemd"
UNIT=/etc/systemd/system/dubpipe-worker.service
sudo tee "$UNIT" >/dev/null <<UNIT
[Unit]
Description=DubPipe worker (recognition, diarization, separation, synthesis on the GPU)
After=network-online.target nvidia-persistenced.service
Wants=network-online.target

[Service]
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=$DIR
Environment=PYTHONUNBUFFERED=1
Environment=HF_HUB_DISABLE_TELEMETRY=1
ExecStart=$DIR/.venv/bin/python $DIR/dubpipe_worker.py --host 0.0.0.0 --port $PORT --data $DIR/data
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable dubpipe-worker >/dev/null
sudo systemctl restart dubpipe-worker
sleep 3
curl -fsS "http://127.0.0.1:$PORT/health" && echo
echo "== готово: в настройках DubPipe укажите server.host — адрес этой машины"
