# DubPipe

**English** · [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-brightgreen.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-263-brightgreen.svg)](#development)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](#requirements)

Automatic English → Russian video dubbing. Feed it a video file or a YouTube URL and get the
same picture back with a Russian voice track instead of the English speech, while the music
and effects stay where they were. It can also produce subtitles only — two SRT files, the
original transcript and the translation.

Everything except the translation step runs locally on the CPU. No GPU required.

> ### ⚠️ Personal use only
>
> DubPipe exists for private copying — watching a video at home in a language you understand.
> **Publishing or distributing the resulting track infringes the rights of the copyright
> holder and violates platform rules.** The tool deliberately has no upload feature of any
> kind, and it never will.

---

## Table of contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Desktop app](#desktop-app)
- [Subtitles](#subtitles)
- [Execution profiles](#execution-profiles)
- [Commands](#commands)
- [Character voices](#character-voices)
- [Review and fix the result](#review-and-fix-the-result)
- [Configuration](#configuration)
- [Performance](#performance)
- [Downloaded components and their licenses](#downloaded-components-and-their-licenses)
- [Privacy and security](#privacy-and-security)
- [Development](#development)
- [Known limitations](#known-limitations)
- [License](#license)

---

## What it does

- **Dubbing.** Speech recognition with word-level timing, translation written to fit the
  time slot, Russian speech synthesis, tempo fitting and mixing back into the video.
- **Subtitles.** Two SRT files — `<name>.en.srt` and `<name>.ru.srt` — laid out by
  readability rules rather than dumped from the recognizer.
- **Character voices.** Speaker diarization assigns a separate voice per speaker, and the
  voice gender is estimated from the pitch of the original speaker, so a man is not dubbed
  by a female voice by default.
- **Review mode.** Watch the finished file, mark what is wrong (voice, speaker, translation,
  volume levels) and re-mix with one button — only the affected replicas are re-synthesized.
- **Resumable cache.** Every stage is cached by input content and stage settings; a repeated
  run recomputes only what actually changed.
- **No system installation.** ffmpeg, yt-dlp, whisper.cpp and piper are downloaded into a
  local folder, not into the system, and no administrator rights are needed.

## How it works

| Stage | What happens | Engine |
|---|---|---|
| S1 | Input handling, audio extraction | ffmpeg (+ yt-dlp for URLs) |
| S2 | Recognition, word timings, speaker diarization | whisper.cpp, silero VAD, pyannote |
| S3 | Translation into Russian, written to fit the slot | Kilo Gateway (cloud) or Ollama (local) |
| S4 | Voice/music separation (optional) | MDX-Net through a Python sidecar |
| S5 | Russian speech synthesis | piper |
| S6 | Fitting each line into its slot (tempo, shortening) | ffmpeg + LLM |
| S7 | Mixing and muxing back into the video | ffmpeg |

Word timings come from whisper.cpp DTW alignment rather than the heuristic offsets: the
heuristic puts the first words of a phrase at the start of the whole segment, which on real
material lands 0.5–1.3 s before the speech actually begins.

Recognition also invents text. Whisper learned subtitle files during training, so on music
and in silence it writes out the boilerplate it saw there — credits for the captions, ad
notices, "thanks for watching" — and sometimes loops a single phrase for minutes. On a Korean
episode that was 68 replicas out of 412, which the pipeline then dutifully translated and
voiced. S2 drops them: known captioning formulas by pattern, and stuck decoding by the one
property real speech never has — identical lines that overlap in time. Repeated lines that do
not overlap are kept, because a character really can say "seriously?" twelve times in a row.

## Requirements

- **Node.js 20+** (tested on 25.9)
- About 2 GB of free space for models and binaries
- **No GPU needed**, though one helps: see [Using the GPU](#using-the-gpu)
- Python is optional and only for two stages: voice separation (`pip install numpy
  onnxruntime`) and speaker diarization (`pip install pyannote.audio`, which pulls in
  PyTorch, ~1 GB). Without Python, separation falls back to ducking the original and every
  line gets a single voice; the rest of the pipeline never touches Python. An optional
  `pip install onnxruntime-directml` moves the speaker embeddings onto the GPU and makes
  diarization four times faster.

The code targets Windows, Linux and macOS; the packaged desktop build and every measurement
in this README come from Windows.

## Installation

```bash
npm install
npm run build                       # or run everything through: npx tsx src/cli.ts
npx tsx src/cli.ts doctor --fetch   # download the missing components (~165 MB)
```

## Quick start

```bash
# 1. Create a configuration file
npx tsx src/cli.ts config init

# 2. Check the environment
npx tsx src/cli.ts doctor

# 3. Produce a dubbed video
npx tsx src/cli.ts process video.mp4 --out video.ru.mp4

# 4. Or subtitles only, both languages
npx tsx src/cli.ts process video.mp4 --to-stage s3 --subtitles
```

By default the result is written next to the source file with a `.ru` suffix. Use
`--out-dir` to choose a folder, or `--out` for an exact path.

A run can be interrupted at any moment — the **Stop** button in the app or Ctrl+C in the
terminal (exit code 130). Child processes are killed immediately and model requests are
aborted; finished stages stay in the cache and the interrupted one is recomputed next time.

## Desktop app

```bash
npm run ui          # opens in the browser
npm run app:dev     # the same thing in an application window
npm run app:build   # build the .exe (installer + portable)
```

The interface is built around one object — a video file. The main screen is a folder of
videos: each file shows whether it has been dubbed, with **Dub** and **Subtitles** buttons.
The file page holds the run controls, per-stage progress with elapsed time, the finished
video, a replica editor, a subtitle editor, model comparison and the log.

If something is missing — a program, model weights, a voice or an API key — a panel at the
top states exactly what will not work and how to fix it. One button downloads everything in
parallel, with progress bars.

The packaged app needs neither Node.js nor Python: an installer and a portable build, about
229 MB each. Its working directory is `%APPDATA%/DubPipe`.

> **On the interface language:** the application UI is in Russian, since the tool dubs *into*
> Russian. The code, this README and the configuration reference are what an English-speaking
> contributor needs; source comments are in Russian or English depending on the module.

## Subtitles

The **Subtitles** button next to **Dub** (or `--subtitles` on the command line) runs
recognition and translation and writes two files next to the video.

Subtitles are not pipeline replicas dumped to disk: replicas are cut for voicing and can be
one word long or four lines wide. Cues are rebuilt under readability rules — at most two
lines of 42 characters, duration between 1 and 7 seconds, a gap of at least 84 ms (two frames
at 24 fps) between neighbours, and a reading speed of at most 17 characters per second. A
long replica is split on sentence boundaries with the time divided proportionally; a line
break prefers punctuation and never leaves a preposition or conjunction dangling at the end
of a line. Files are UTF-8 with a BOM, otherwise Windows players mangle Cyrillic.

The **Subtitles** tab shows the cues of both languages with per-cue warnings (too fast to
read, overlap, line too long), lets you edit text and timecodes, and renders the cues over
the video. All rules are configurable under `subtitles:` in `config.yaml`.

A run without voicing — subtitles, or anything stopping at translation — skips speaker
diarization, since speakers are only used to hand out voices. On a 15-minute episode that
brings recognition down to about 1.5 minutes; with diarization the same stage takes five to
six. The recognition cache keeps the two apart, so a later dubbing run does not pick up a
transcript that has no speakers in it.

## Languages

The **source language** is a parameter, not an assumption. Set `asr.language` and the
pipeline adapts what actually depends on the writing system: how much longer a translation
may be than its source (×2 for English, ×3 for Korean, ×5 for Chinese and Japanese — a
character carries more meaning than a letter), whether recognized words are joined with
spaces, the subtitle line width and reading speed, and which characters end a sentence.
A language without a profile gets Latin rules. Subtitle files are named by language code,
so a Korean episode yields `episode.ko.srt` next to `episode.ru.srt`.

The **interface language** is switched next to the application name and remembered between
runs. The UI ships in English and Russian; messages that come from the server, such as the
readiness panel, arrive in the chosen language too. Pipeline log messages stay in Russian.

## Execution profiles

| | `offline` | `hybrid` (default) |
|---|---|---|
| Network after the models are downloaded | not needed | only for translation |
| API keys | none | a Kilo Gateway key for S3 |
| Translation | a local LLM through Ollama | `anthropic/claude-sonnet-4.5` |
| Everything else | local | local |

Switching takes one line in `config.yaml`:

```yaml
profile: offline
```

If the key is missing or the gateway is unreachable in the `hybrid` profile, translation
degrades to the local model instead of failing the run.

### The gateway key

```bash
# Linux/macOS
export KILO_API_KEY="your-token"
# Windows PowerShell
$env:KILO_API_KEY = "your-token"
```

The variable name is set by `kilo_gateway.api_key_env`; the key itself never goes into
`config.yaml`. In the app you paste it into a field and it is stored separately from the
settings. The gateway routes `/chat/completions` only — it has no speech synthesis, and its
transcription returns no timings — so the key is used **for translation only**, while
recognition and synthesis always run locally.

## Commands

| Command | Purpose |
|---|---|
| `dub process INPUT [--out FILE] [--out-dir DIR] [--subtitles] [--model ID] [--from-stage ID] [--to-stage ID]` | process an input |
| `dub config init [--force]` | create `config.yaml` from the example |
| `dub cache clear [INPUT]` | clear the stage cache |
| `dub doctor [--fetch]` | check and install dependencies |
| `dub models [--search TEXT] [--free]` | list translation models with prices |
| `dub compare INPUT --models A,B [--apply M]` | compare translation quality across models |
| `dub ui [--port N] [--no-open]` | graphical interface |
| `dub voices list [--demo]` | voices of the active TTS engine |
| `dub export-srt INPUT [--lang en\|ru]` | export subtitles |
| `dub evaluate INPUT [--golden FILE]` | compare timings against a reference |

Exit codes: `0` success, `1` stage error, `2` configuration error, `3` missing external
dependency, `130` cancelled by the user.

### Choosing a translation model

The model is set by `translate.model`, or once by `--model`. To choose with data rather than
by gut feeling, run the same replicas through several models:

```bash
npx tsx src/cli.ts models --search claude   # what is available and at what price
npx tsx src/cli.ts compare video.mp4 --models anthropic/claude-sonnet-4.5,openai/gpt-5.2
```

The output is a summary plus a line-by-line comparison; `--apply MODEL` writes the variant
you liked into `segments.json` without translating again. Local models join the comparison
with an `ollama:` prefix. The app has the same thing on the **Model comparison** tab, plus a
**Test model** button in the settings that translates three sample lines and reports whether
the model answers at all, answers in Russian, and at what cost.

## Character voices

Who is speaking is determined by pyannote (`pyannote/speaker-diarization-community-1`)
locally on the CPU through the `python/diarize.py` sidecar. Speakers are named `speaker_0`,
`speaker_1`… in order of first appearance; a replica where the speaker changes mid-phrase is
split on a word boundary. One-time setup:

1. Python 3.10+ and `pip install pyannote.audio` (the app does this from its *Download
   missing* button).
2. A free Hugging Face account: accept the conditions on the model page, create a read token
   and paste it into the settings or the `HF_TOKEN` variable. The token is only needed to
   download the weights (~30 MB); after that the stage works offline.

Without any of that, the stage is skipped with a stated reason and every line gets
`speaker_0`.

The gender of each speaker's voice is estimated from the pitch of the original recording, so
a speaker with no explicit assignment gets a voice of their own gender — different male
voices in rotation for different men. Explicit `tts.voice_map` entries and per-video edits
always win over the automatic choice.

## Review and fix the result

Once a dub exists, the file page shows a **Review and fix** panel: the finished video, the
replica playing right now, and controls to change its translation, its speaker, the voice of
that speaker (including one-click *make this voice male/female*) and the volume of the
original, the Russian speech and the ducking. Changes accumulate as marks; one button saves
them and re-runs only what is needed — re-synthesis of the affected replicas, or just a
re-mix when only volumes changed. Per-video edits live in `overrides.json` inside that
video's working folder and never touch the global settings.

## Configuration

`config.yaml` is created by `dub config init` from [config.yaml.example](config.yaml.example),
which documents every field. The main groups: `profile`, `asr` (model, language, VAD,
diarization), `translate` (engine, model, batch size, length tolerance), `tts` (voice,
`voice_map`), `separation`, `alignment`, `mix`, `subtitles`, `cache`.

Between stages you can edit `segments.json` by hand in the working folder and continue from
any stage:

```bash
npx tsx src/cli.ts process video.mp4 --from-stage s3
```

The same folder holds `run.log`, a log of every run of that file. If a result looks strange,
that is the first place to look.

## Using the GPU

The two most expensive steps can run on the GPU, by two different mechanisms.

**Recognition.** whisper.cpp publishes no AMD builds, so the CPU build is chosen
automatically. A Vulkan build can be selected by hand — `asr.backend: vulkan` —
and the program says out loud that the archive comes from a third party. On a
Radeon 780M an episode was recognised twice as fast: 2m18s against 4m57s. The
text differs by about 9%: backends round differently, and on hard passages —
shouting, singing — the decoding paths diverge.

**Working out who speaks.** Here 96% of the time goes into a single network, the
speaker embedding: 105 seconds out of 108 on a five-minute clip. It is exported
to ONNX and runs through DirectML on any DirectX GPU: 27 seconds against 122 on
the CPU, four times faster, with results identical down to fifty milliseconds and
the speaker label. The segmentation network stays on the CPU — it is tiny, and on
the GPU it is ten times slower, because the transfers cost more than the
arithmetic saves.

**Separating voice from music.** The same shape again: a heavy network next to
light signal processing. The network moved to the GPU, the Fourier transform
stayed in numpy. A minute of audio is processed in 3 seconds instead of 17 —
five times faster — and the result matches the CPU one to within −94 dB, below
the threshold of hearing.

Nothing needs configuring: with `onnxruntime-directml` installed the embeddings
run on the GPU, otherwise the old path is used. The ONNX export happens once and
is kept next to the weights.

The device is chosen per stage — `asr.diarization.device` and
`separation.device`, sharing one vocabulary: `auto`, `cpu`, `gpu`, `igpu`,
`dgpu`. There is deliberately no single "everything on the GPU" switch: the
segmentation network is ten times slower there than on the CPU.

The speaker breakdown is also not recomputed for nothing. It depends on the audio
and on its own settings, never on which model transcribed the words, so the result
is stored with a fingerprint of the recording and reused. Switching the ASR model
used to cost all seventeen minutes again; now it costs nothing.

ROCm on Windows is neither needed nor advised for this: MIOpen compiles its
kernels at run time, the ROCm packages ship no C++ standard headers, and the
compilation fails on every kernel. That is an AMD defect, reproducible on
supported cards too ([ROCm#6150](https://github.com/ROCm/ROCm/issues/6150)).

## Performance

Measured on a Ryzen 7 8745HS (8 cores, no GPU) with `whisper-small`:

| Operation | Time |
|---|---|
| Full cycle on a 12-second clip (6 stages) | 16–27 s |
| Recognition of a 12-second clip | 4.3 s (≈3× faster than real time) |
| Translation of 5 replicas through the gateway | 7.3 s |
| Synthesis of 5 replicas (piper) | 8 s |
| A whole run served from cache | 5 ms |

On a real 12-minute episode: recognition with diarization about 5 minutes, translation about
2.5 minutes (~$0.25 through the gateway on Sonnet 4.5), synthesis 20 s, fitting and mixing
about 2 minutes. Subtitles for an already processed file are written in milliseconds.

## Downloaded components and their licenses

DubPipe itself is MIT. It does **not** bundle or redistribute third-party binaries: they are
downloaded from their upstream sources on first use and stay under their own licenses.

| Component | Size | License |
|---|---|---|
| ffmpeg (gyan.dev build) | 106 MB | GPL/LGPL |
| yt-dlp | 17 MB | Unlicense |
| whisper.cpp (BLAS build) | 20 MB | MIT |
| whisper `small` ggml model | 465 MB | MIT |
| silero-vad (ONNX) | 2 MB | MIT |
| piper | 21 MB | MIT |
| piper `ru_RU-*` voices | ~60 MB each | MIT / CC BY |
| pyannote diarization (optional) | 38 MB | MIT, gated by a free Hugging Face account |
| MDX-Net separation model (optional) | 67 MB | MIT |

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the details, including what this
means if you package the application yourself.

**About edge-tts:** it is an unofficial client for a Microsoft service. Using it may violate
that service's terms and its limits can change without notice, so the default synthesis path
is local piper; edge-tts has to be enabled explicitly.

## Privacy and security

- The local API server listens on `127.0.0.1` only, on a random port, and every start issues
  a one-time token. Paths coming from requests are never read outside the working directory.
- The API key is never sent to the web page — only the fact that it is set, plus a masked
  form. Keys live in `secrets.json` inside the cache directory, separately from
  `config.yaml`, which stays safe to share.
- In the `offline` profile nothing leaves the machine once the models are downloaded. In
  `hybrid`, only the text of the replicas goes to the translation gateway — never audio or
  video.
- Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Development

```bash
npm test              # 284 tests; no ffmpeg, no network and no keys required
npm run typecheck
npm run build
npx electron scripts/screenshot-ui.cjs     # screenshots of every screen
npx tsx scripts/check-subtitles.mts FILE   # validate generated SRT files
node scripts/make-fixture.mjs              # rebuild the test clip and its reference
```

The test clip is synthesized locally with piper, so the fixture is reproducible and carries
nobody's rights: every boundary in `tests/fixtures/golden.json` is constructed, not measured.

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Engineering decisions,
measurements and the reasoning behind them are recorded in [SPEC.md](SPEC.md) (in Russian).

## Known limitations

1. Diarization does not separate overlapping voices: a replica goes to whoever speaks longer.
2. On-screen text and captions are not translated.
3. With separation enabled, songs lose their vocals along with the speech.
4. No GPU acceleration: on AMD integrated graphics under Windows neither CUDA nor ROCm is
   available, and no Vulkan builds of whisper.cpp are published.
5. Estimating a line's duration from its character count is approximate; exact fitting is done
   by stage S6 through tempo and shortening, not by the estimate at translation time.
6. Source languages other than English do run (whisper is multilingual), but several defaults
   assume Latin script: the translation length cap, word joining for languages written without
   spaces, and the subtitle line width.

## License

[MIT](LICENSE) © 2026 Mikhail Sergeev.

The license covers this source code. Downloaded third-party components keep their own
licenses, and the material you process keeps its copyright — see the personal-use notice at
the top of this file.
