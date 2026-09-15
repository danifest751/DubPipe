# Third-party components

**English** · [Русский](THIRD-PARTY-NOTICES.ru.md)

DubPipe is distributed under the [MIT license](LICENSE). This repository contains **no
third-party binaries or model weights**: they are downloaded from their upstream sources the
first time they are needed, into a local cache directory (`.dubpipe/tools`, `.dubpipe/models`
or `%APPDATA%/DubPipe` for the packaged app). Each component remains under its own license,
and the download happens on the user's machine, at the user's request.

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
| pyannote speaker diarization | who is speaking (optional) | MIT | https://huggingface.co/pyannote |
| UVR MDX-Net models | voice/music separation (optional) | MIT | https://huggingface.co/seanghay/uvr_models |

The pyannote pipeline is gated: a free Hugging Face account and acceptance of the model's
conditions are required to download the weights. The token is used only for that download.

## Bundled dependencies

The npm dependencies (`commander`, `yaml`, `zod`, `onnxruntime-node`) and the development
dependencies (`typescript`, `vitest`, `electron`, `electron-builder`, `tsx`) are all under
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
