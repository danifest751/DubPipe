#!/bin/sh
# Запуск dubpipe-worker в контейнере.
#
# При первом старте докачивает то, что X-Voice сам скачать не может: вокодер
# (ищется по локальному пути) и модель языков fastlid — её адрес
# dl.fbaipublicfiles.com из России не отвечает, берём ту же модель с зеркала на
# Hugging Face. Всё — на том /data, второй старт ничего не качает. Не скачалось —
# сервис стартует без голосов актёров, остальное работает.
set -eu

mkdir -p /data/home/.cache /data/xvoice/hf /data/xvoice/my_vocoder

prepare_clone() {
  lid=/data/home/.cache/lid.176.ftz
  if [ ! -f "$lid" ]; then
    echo "голоса актёров: модель языков fastlid"
    curl -fsSL --max-time 300 -o "$lid.part" \
      https://huggingface.co/julien-c/fasttext-language-id/resolve/main/lid.176.ftz || return 1
    echo "340156704bb8c8e50c4abf35a7ec2569  $lid.part" | md5sum -c --quiet || return 1
    mv "$lid.part" "$lid" || return 1
  fi
  # Модель, которой сервис проверяет реплики голосами актёров (1.6 ГБ). Без
  # предзагрузки её качает первая проверка, и первый дубляж стоит минуты.
  if [ ! -d /data/models/hf/hub/models--deepdml--faster-whisper-large-v3-turbo-ct2 ]; then
    echo "проверка голосов: модель распознавания (1.6 ГБ, один раз)"
    /opt/dubpipe/.venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('deepdml/faster-whisper-large-v3-turbo-ct2', cache_dir='/data/models/hf/hub')" \
      || echo "проверка голосов: модель не скачалась — её скачает первая проверка" >&2
  fi
  [ -f /data/xvoice/.ready ] && return 0
  echo "голоса актёров: веса X-Voice и вокодер (около 1.4 ГБ, один раз)"
  HF_HOME=/data/xvoice/hf /opt/xvoice/.venv/bin/python - <<'PY' || return 1
from huggingface_hub import hf_hub_download, snapshot_download

snapshot_download("charactr/vocos-mel-24khz", local_dir="/data/xvoice/my_vocoder/vocos-mel-24khz")
for name in ("XVoice_Base_Stage1/model_600000.safetensors", "XVoice_Base_Stage1/vocab.txt"):
    hf_hub_download("XRXRX/X-Voice", name)
PY
  touch /data/xvoice/.ready
}

xvoice=/nonexistent
if [ "${DUBPIPE_CLONE:-1}" = 1 ]; then
  if prepare_clone; then
    xvoice=/opt/xvoice
  else
    echo "голоса актёров: веса не скачались — сервис стартует без них; перезапустите контейнер, когда появится сеть" >&2
  fi
fi

exec /opt/dubpipe/.venv/bin/python /opt/dubpipe/dubpipe_worker.py \
  --host 0.0.0.0 --port 8770 --data /data \
  --comfyui "${DUBPIPE_COMFYUI:-http://host.docker.internal:8188}" \
  --ollama "${DUBPIPE_OLLAMA:-http://host.docker.internal:11434}" \
  --xvoice "$xvoice"
