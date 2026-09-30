# Third-party components

**English** · [Русский](THIRD-PARTY-NOTICES.ru.md)

DubPipe is distributed under the [MIT license](LICENSE). This repository contains **no
third-party binaries or model weights**: they are downloaded from their upstream sources the
first time they are needed, into a local cache directory (`.dubpipe/tools`, `.dubpipe/models`
or `%APPDATA%/DubPipe` for the packaged app); on a GPU server, into the service's directory
(`~/dubpipe-worker` by default) or the Docker volume `/data`. Each component remains under
its own license, and the download happens on the user's machine, at the user's request.

## Downloaded at runtime

| Component | Purpose | License | Source |
|---|---|---|---|
| ffmpeg (gyan.dev build) | audio/video processing | GPL/LGPL | https://www.gyan.dev/ffmpeg/builds/ |
| yt-dlp | downloading videos by URL | Unlicense | https://github.com/yt-dlp/yt-dlp |
| whisper.cpp | speech recognition | MIT | https://github.com/ggml-org/whisper.cpp |
| whisper ggml models | recognition weights | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| silero-vad (ONNX) | voice activity detection | MIT | https://github.com/snakers4/silero-vad |
| piper | speech synthesis | MIT | https://github.com/rhasspy/piper |
| piper `ru_RU-*` voices | Russian voices | MIT / CC BY | https://huggingface.co/rhasspy/piper-voices |
| silero TTS `v5_5_ru` | 5 accent-free Russian voices | CC BY-NC-SA 4.0 — **non-commercial** | https://github.com/snakers4/silero-models |
| silero TTS `v5_cis_base` | 29 Russian voices | CC BY-NC-SA 4.0 — **non-commercial** | https://github.com/snakers4/silero-models |
| pyannote.audio (installed with pip) | who is speaking (optional) | MIT | https://github.com/pyannote/pyannote-audio |
| pyannote `speaker-diarization-community-1` | diarization weights (optional) | CC BY 4.0 | https://huggingface.co/pyannote/speaker-diarization-community-1 |
| faster-whisper models `Systran/faster-whisper-*` | recognition weights for faster-whisper (NVIDIA GPU) | MIT | https://huggingface.co/Systran |
| `deepdml/faster-whisper-large-v3-turbo-ct2` | `large-v3-turbo` for faster-whisper; on the server also the check of actors' voices | MIT | https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2 |
| UVR MDX-Net models | voice/music separation (optional) | MIT | https://huggingface.co/seanghay/uvr_models |

The pyannote pipeline is gated: a free Hugging Face account and acceptance of the model's
conditions are required to download the weights. The token is used for that download; with
a GPU server it is also sent to your server with every diarization request (see
[SECURITY.md](SECURITY.md)).

## Installed on the GPU server (optional)

`scripts/server/install-worker.sh` or the Docker image `docker/worker/Dockerfile` installs
these on the machine that runs `dubpipe-worker`, not on the workstation. Nothing of this
ships with DubPipe.

| Component | Purpose | License | Source |
|---|---|---|---|
| Ubuntu 24.04 (`ubuntu:24.04`, Docker image only) | base of the image | each package under its own license | https://hub.docker.com/_/ubuntu |
| uv (`ghcr.io/astral-sh/uv:0.12.19` in the image) | Python package manager used for installation | MIT or Apache-2.0 | https://github.com/astral-sh/uv |
| CPython 3.12 and 3.11 (installed by uv) | Python for the service and for X-Voice | PSF-2.0 | https://www.python.org |
| PyTorch, CUDA libraries | GPU runtime | BSD / NVIDIA EULA | https://pytorch.org |
| faster-whisper, CTranslate2 | recognition on the GPU | MIT | https://github.com/SYSTRAN/faster-whisper |
| pyannote.audio | diarization on the GPU | MIT | https://github.com/pyannote/pyannote-audio |
| onnxruntime-gpu | separation on the GPU | MIT | https://github.com/microsoft/onnxruntime |
| X-Voice (`--with-clone`) | actors' voices | code MIT, weights CC BY-NC 4.0 — **non-commercial** | https://github.com/sunnyxrxrx/X-Voice, https://huggingface.co/XRXRX/X-Voice |
| DeepFilterNet (X-Voice dependency) | noise suppression | MIT / Apache-2.0 | https://github.com/Rikorose/DeepFilterNet |
| Vocos 24 kHz | X-Voice vocoder | MIT | https://huggingface.co/charactr/vocos-mel-24khz |
| espeak-ng (built from source) | text to phonemes for X-Voice | GPL-3.0 | https://github.com/espeak-ng/espeak-ng |
| fastText `lid.176`, mirror `julien-c/fasttext-language-id` | language detection used by X-Voice | CC BY-SA 4.0 on the mirror's card; the original model is CC BY-SA 3.0 | https://huggingface.co/julien-c/fasttext-language-id, https://fasttext.cc/docs/en/language-identification.html |
| Ollama (`ollama/ollama` image, `--profile ollama` only) | local translation on the server | MIT | https://github.com/ollama/ollama |
| Gemma 4 (`gemma4:26b-a4b-it-qat`, pulled by you) | default translation model on the server | Apache-2.0 | https://ai.google.dev/gemma/docs/gemma_4_license |

Cloning an actor's voice copies a personal characteristic of a real person: keep the result
for private viewing, as the rest of DubPipe's output.

## Bundled dependencies

The npm dependencies (`commander`, `yaml`, `zod`, `onnxruntime-node`) and the development
dependencies (`typescript`, `vitest`, `electron`, `electron-builder`, `tsx`,
`@playwright/test`, `playwright`, `playwright-core`) are all under
permissive licenses — MIT, ISC or Apache-2.0. See `package.json` and `npm ls --all` for the
exact set and versions.

## Data included in the source

`src/stages/hallucination-phrases.ts` holds 89 phrases that whisper invents on noise,
taken from the [sachaarbonel/whisper-hallucinations](https://huggingface.co/datasets/sachaarbonel/whisper-hallucinations)
dataset (MIT). Only long phrases that either appeared more than once or name subtitles,
subscriptions or thanks for watching were kept; the file says why.

## If you package the application yourself

`npm run app:build` produces an Electron application that contains this project's code and
Electron itself (MIT). It does **not** contain ffmpeg, models or voices — those are fetched
at runtime as described above.

If you ever decide to ship a build with ffmpeg included, note that the common Windows builds
of ffmpeg are **GPL** and that changes the licensing obligations of the whole distribution.
Ship the LGPL build, or keep the download-at-runtime model that this project uses.

## Content you process

Videos, audio and the resulting tracks are not covered by any license in this repository.
They belong to their copyright holders, and DubPipe is intended for private copying only —
see the notice at the top of the [README](README.md).
