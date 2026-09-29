# dubpipe-worker in Docker

[Русский](README.ru.md)

The DubPipe service for a machine with an NVIDIA GPU, packed into one image. It
takes the heavy stages of the pipeline: speech recognition, speaker
diarization, voice separation, synthesis and actors' voices. The DubPipe app
stays on the workstation and sends the service audio over the local network.

The image does what `scripts/server/install-worker.sh --with-clone` does, but
with one command and with exact package versions. Installing without Docker is
still possible — see "A GPU server" in the [main README](../../README.md).

## What is inside

| Part | Why |
|---|---|
| Service environment (Python 3.12, torch 2.11 + CUDA 12.8) | faster-whisper, pyannote 4, onnxruntime-gpu, silero |
| X-Voice environment (Python 3.11, torch 2.8 + CUDA 12.8) | actors' voices; its CTranslate2 4.5 clashes with the service environment |
| espeak-ng built from source | phonemes for X-Voice, pinned version |
| `entrypoint.sh` | on first start downloads the X-Voice weights, the vocoder, the voice-check model and the fastlid language model |

The versions of all packages (about 350) are pinned in `worker.lock.txt` and
`xvoice.lock.txt`, frozen from the working server. The image is built from
exactly the tested combination, not from whatever PyPI has on the day of the
build.

Model weights are not in the image: they are large, and X-Voice's are also
non-commercial (CC BY-NC). Everything downloaded lives on the `/data` volume and
survives rebuilding and updating the image.

## Requirements

- An NVIDIA GPU that CUDA 12.8 supports (tested on a CMP 50HX, Turing
  architecture) and an NVIDIA driver 570 or newer.
- **Linux:** Docker Engine with the Compose plugin and the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
- **Windows:** Docker Desktop with WSL 2 — it passes the GPU through by itself,
  there is no CUDA to install in Windows. The regular NVIDIA driver for Windows
  is needed.
- Disk: about 22 GB for the image and 8–10 GB for the models on the volume.
- GPU memory: about 8 GB is enough for any single stage; the service runs jobs
  one at a time.

Check that Docker sees the GPU:

```bash
docker run --rm --gpus all ubuntu nvidia-smi
```

## Installing

From the DubPipe repository root:

```bash
cp docker/worker/.env.example docker/worker/.env    # optional, see "Settings"
docker compose -f docker/worker/compose.yaml up -d --build
```

The first build takes about half an hour: it installs two Python environments
and builds espeak-ng. The first start then spends a few minutes downloading
about 3 GB of weights. Readiness shows in the log:

```bash
docker compose -f docker/worker/compose.yaml logs -f worker
# … dubpipe-worker слушает 0.0.0.0:8770, умеет: {'clone': True, 'clone_check': True, …}
```

and at `http://<machine address>:8770/health`.

Then in DubPipe: **Settings → Compute → GPU server** — the machine address, or
in `config.yaml`:

```yaml
server:
  host: 192.168.0.70      # address of the machine running the container
  worker_port: 8770       # if you changed DUBPIPE_WORKER_PORT
```

**A GPU in the same computer as DubPipe** — the same container, with the
address `127.0.0.1` in the settings.

## Settings

All of them go into `docker/worker/.env` (see `.env.example`):

| Variable | Default | What it sets |
|---|---|---|
| `DUBPIPE_WORKER_PORT` | `8770` | the service port on this machine |
| `DUBPIPE_CLONE` | `1` | `0` — no actors' voices, their weights (about 3 GB) are not downloaded |
| `DUBPIPE_COMFYUI` | `http://host.docker.internal:8188` | where ComfyUI is on this machine |
| `DUBPIPE_OLLAMA` | `http://host.docker.internal:11434` | where Ollama is on this machine |
| `OLLAMA_PORT` | `11434` | the port of Ollama in a container (only with `--profile ollama`) |

**ComfyUI and Ollama.** The GPU is usually shared: ComfyUI keeps its last models
on it, and Ollama holds the language model for minutes after translating. When
a job lacks memory, the service unloads an idle ComfyUI, then the Ollama models
— for that it needs their addresses. A running generation is never touched. If
they are not on the machine, these settings do nothing. For the container to
reach them they must listen on more than `127.0.0.1` (for Ollama,
`OLLAMA_HOST=0.0.0.0`).

**No Ollama of your own** — start one next to it in a container:

```bash
docker compose -f docker/worker/compose.yaml --profile ollama up -d
docker compose -f docker/worker/compose.yaml exec ollama ollama pull gemma4:26b-a4b-it-qat
```

**The Hugging Face token** does not need to be stored on the server: DubPipe
sends it with a diarization request, and the service downloads the pyannote
weights once. The terms of
[pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
must be accepted on Hugging Face and the token set in DubPipe (Settings →
Compute → "Hugging Face token").

## Where things are

The `dubpipe-data` volume is mounted at `/data`:

| Path | Contents |
|---|---|
| `/data/models` | weights for recognition, diarization, separation, silero, the voice-check model |
| `/data/xvoice` | X-Voice weights and the vocoder |
| `/data/refs` | voice samples sent by the app |
| `/data/jobs` | files of current jobs; removed by themselves after three hours |
| `/data/home` | the service's home directory: library caches, the fastlid language model |

To see how much is used: `docker system df -v | grep dubpipe-data`.

## Updating

After `git pull` in the repository:

```bash
docker compose -f docker/worker/compose.yaml up -d --build
```

The environment layers are rebuilt only if `*.lock.txt` or the `Dockerfile`
changed; updating just the service scripts takes seconds. The model volume is
left alone.

## Moving from the systemd service

If the service was installed with `install-worker.sh`, it holds the same port.
Stop the unit first, then start the container:

```bash
sudo systemctl disable --now dubpipe-worker
docker compose -f docker/worker/compose.yaml up -d --build
```

The container downloads the models to its own volume again — it does not use
the old `~/dubpipe-worker` directory, which can be removed once the container
has proven itself. To go back: `docker compose … down` and
`sudo systemctl enable --now dubpipe-worker`.

To try the container without stopping the unit, use another port:

```bash
DUBPIPE_WORKER_PORT=8771 docker compose -p dubpipe-test -f docker/worker/compose.yaml up -d
```

and set `server.worker_port: 8771` in DubPipe. To remove the trial container
together with its volume: `docker compose -p dubpipe-test -f docker/worker/compose.yaml down -v`.

## Troubleshooting

**`could not select device driver "nvidia"`** — the NVIDIA Container Toolkit is
not installed, or Docker was not restarted after installing it
(`sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`).

**The service started without actors' voices** (`'clone': False` in the log) —
the X-Voice weights did not download on first start; the reason is in the log
above. Restart the container once the network is back:
`docker compose … restart worker`.

**Diarization fell back to the workstation** with "no access to the model
weights" — DubPipe has no Hugging Face token, or the pyannote terms are not
accepted. When DubPipe runs from the command line, the token comes from the
`HF_TOKEN` variable.

**The run report says "the server computed on the CPU"** — GPU memory is taken
and there is nothing to unload: the service cannot reach ComfyUI or Ollama at the
addresses in `.env`, or something else holds the memory. `nvidia-smi` on the
machine shows what.

**The first job of each kind is slow** — the service is downloading its model:
recognition needs 3 GB, separation 64 MB, silero 230 MB. It happens once.

**The service does not answer another computer** — it only answers local
network and VPN addresses (like Ollama next to it); check that the port is open
in the machine's firewall.

**Disk space** — after build experiments the Docker build cache can take tens of
gigabytes: `docker builder prune -af`. The image and the model volume are not
touched.

## Removing

```bash
docker compose -f docker/worker/compose.yaml down        # stop, keep the models
docker compose -f docker/worker/compose.yaml down -v     # with the model volume
docker image rm dubpipe-worker:latest
```
