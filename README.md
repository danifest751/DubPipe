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
| S5 | Russian speech synthesis | piper or silero |
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

### What happens to the original track

The Russian speech goes over the original, so something has to be done with it.
There are three ways, chosen by the settings.

Without separation — the default — the original is **ducked** by 18 dB under our
speech. Simple and reliable, but the music dips along with the foreign voice.

With separation on, the **extracted voice is subtracted** from the original, and
only where our own speech plays. The music stays at full level, and between
replicas the original is untouched, so a song we do not dub keeps its vocals.
That is the default, `separation.apply: under_speech`.

`everywhere` replaces the original with the rebuilt background for the whole
film. It removes the original voice everywhere, and strips songs of their vocals.

### The speech rate is measured, not guessed

How many characters the synthesizer speaks per second decides how long a
translation to ask for, and one number cannot describe it. Every replica carries
a fixed cost — the approach to the phrase and the tail after it. Measured on 255
replicas of one voice: lines under 15 characters come out at 10.2 characters per
second, lines over 80 at 16.6, with the voice unchanged.

So a straight line is fitted — `duration = overhead + characters / rate` — and on
that material it gave 0.51 seconds and 17.8 characters per second. The real
speaking rate is nearly twice the apparent one, and long lines used to be asked
for a third less text than they could hold.

Both numbers are measured on every run and remembered, for the recording and for
the voice itself, so the first run of the next video aims correctly. A
measurement taken on a different voice is never used: it is worse than an honest
default.

### Fitting to the timing

A replica that does not fit its slot used to be rewritten shorter by the model,
losing meaning. Fitting now first borrows the silence that follows the replica,
up to 1.2 seconds, never crossing into the next one. On a Korean episode that
took the number of rewritten replicas from 52 down to 1, and sped-up ones from
114 down to 9.

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

### Local translation through Ollama

The `offline` profile translates with a local model: nothing leaves the machine, no keys are
needed, and every episode is free. What it takes:

1. Install Ollama (`winget install Ollama.Ollama`, or from ollama.com) and pull a model:
   `ollama pull qwen2.5:7b-instruct`. The `offline` profile uses that one unless you choose
   another.
2. In the interface: Settings → Translation, profile "offline" — the model field then lists
   what is pulled locally. The same in `config.yaml`:

```yaml
profile: offline
translate:
  model: qwen3:8b            # the name as `ollama list` shows it
  ollama_endpoint: http://127.0.0.1:11434
```

The Environment screen does not check that Ollama is installed; it asks the daemon whether
the chosen model is actually there.

**An integrated GPU has to be enabled explicitly.** Ollama sees it and silently drops it —
in the log that reads `dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1`. Set
that variable and restart Ollama. Measured on a Radeon 780M with a real translation request:

| | through Vulkan | CPU only |
|---|---|---|
| Prompt processing | 243 tok/s | 59.6 tok/s |
| Generation | 8.9–16.2 tok/s | 6.0 tok/s |

ROCm does not work on that card (`no rocblas support for gfx target gfx1103`); Vulkan does,
through AMD's own driver. The GPU is not limited to the BIOS carve-out either: with unified
memory Ollama reported 27.9 GB of 40 available, so a 14B model fits comfortably.

**How they translate.** Measured with the project's own `dub compare` on twenty lines of a
real episode: how many translations fit the character budget their slot allows (the spec asks
for ≥90%).

| Model | Fit | Requests for 20 lines | Time |
|---|---|---|---|
| `qwen3:4b` | 6/20 | 21 | 133 s |
| `qwen3:8b` | 7/20 | 13 | 227 s |
| `qwen3:14b` | 5/20 | 13 | 402 s |
| `mistral-nemo:12b` | 6/20 | 13 | 284 s |
| `qwen2.5:7b-instruct` | 6/20 | 13 | 300 s |

Size does not decide it here: the 14B was the worst of the five and three times slower than
the 4B. All of them translate understandably, but **none of them respects the length budget** —
and that budget is what decides whether a line lands in its slot. S6 then has to make up the
difference by shortening lines with the same local model, so the slow part multiplies. The
sample is small, twenty lines, and other material may rank them differently, but the order of
magnitude is this.

**What to expect in time.** Generation is bound by memory bandwidth, so speed falls with
model size: 7–8B at Q4 gives roughly 9–16 tokens per second, 12–14B about half that. An
episode of 136 lines is on the order of 20,000 prompt tokens and 4,000 generated, which means
**minutes, not seconds**; the same work in the cloud takes about a minute and costs cents.
Local translation is worth it for offline use and privacy, not for savings.

### The final translation review

Translation runs in batches of ten lines and sees three neighbours — enough for a phrase,
not for a film. A whole class of errors is invisible in that frame: a character's name
spelled three ways, masculine verbs for a female character, informal address in one scene
and formal in the next, a fragment left untranslated. The review is one more pass that sees
**the whole translation at once**, along with each speaker's gender (measured from the voice
in S2), the character names and the glossary.

```yaml
translate:
  review:
    enabled: true   # the hybrid profile turns it on by itself; set false to refuse it
```

**The profile decides.** With `hybrid` the review runs by default, because a cloud reviewer
earns the pass: on a deliberately damaged episode `claude-sonnet-4.5` proposed 13 edits and
all 13 survived the guards, in 18 seconds. With `offline` it stays off — the same run gave
`mistral-nemo:12b` 133 seconds to find one edit, and that one was an invention. Whatever is
written in `config.yaml` wins over both.

Edits are not taken on faith. Each one goes through the same fit ruler the translation and
the length pass use: an edit that fits its slot worse than the old text is rejected, because
trading accuracy for drift is a bad deal. And a review that rewrites more than half the lines
is discarded whole - that is a retranslation, not an edit.

An edit that misses its slot is not thrown away in silence: the reviewer is shown its own
proposal, its own stated reason and the exact shortfall in characters, and asked to fit while
keeping the correction (`fit_retries`).

Measured on a real episode - 136 lines, the translation deliberately damaged by a weak model,
reviewed by `anthropic/claude-sonnet-4.5`, 18 seconds:

| | |
|---|---|
| Edits proposed | 13 |
| **Accepted** | **13** |
| Of those, recovered by the refit round | 4 |

Among them: «ты действительно **начал** вести себя странным — что случилось с **Эвей**» →
«**начала** вести себя странно — что случилось с **Евой**» (gender, grammar and the name's
case in one line), «Я бы **хотел** их узнать» → «хотела», and «ты, наверно, **прав**» →
«**права**» - the gender of the person addressed, inferred from neighbouring lines - plus six
lines left untranslated.

**The ruler went from ceiling to target and back, and the journal says why.** The first
version told the model "no longer than N characters", and it dutifully came back at half
that: 27 of 46 proposals were discarded. Replacing the ceiling with a target and its
tolerance bounds fixed that and created something worse: of 18 accepted edits on episode 3,
every one was about length, and several padded the line with what had just been said — «Ты
убил троих наших людей, помнишь?» became «Ты убил троих наших. Троих наших людей.»
Forbidding it in the prompt changed nothing; the model obeys the data. So the reviewer is no
longer told that a line is short at all: it gets `max_chars` and `over`, which is zero unless
the line does not fit. The edits are language again — a calque undone, a filler cut, verb
government fixed.

An undershoot is also priced lower than an overshoot when an edit is judged, at a third: a
line that runs long forces S6 to speed it up or cut it and is heard on every viewing, while a
line that ends early leaves a pause nobody notices. Pricing it at zero was tried and
reverted — the reviewer then stripped content it judged redundant, and the fit fell from
72.4% to 60.5%.

**The review reaches the subtitles too.** The Russian subtitles are built from the same
`segments.json` as the voicing, so corrected text lands in them by itself.

**Choose a strong reviewer.** The guards protect the timing, not the meaning: an invention
that happens to fit the slot passes straight through, and there is no cheap mechanical check
for it - telling that an edit is about something else requires understanding the text.
Measured on the same material:

| | `claude-sonnet-4.5` | `mistral-nemo:12b` | `qwen3:14b` |
|---|---|---|---|
| Edits proposed | **13** | 1 | 5 |
| Accepted | **13** | 1 | **0** |
| No-ops (text unchanged) | 0 | 0 | 4 |
| Time | **18 s** | 133 s | 196 s |

The single edit mistral-nemo proposed was an invention: it replaced «Hey, I care about Ethan
just as much as you do get a grip» with «Ну да, я был не в себе, но я не могу просто так
взять и уйти» - and that passed the length check. qwen3:14b returned four no-ops and changed
nothing at all.

So it is worth having the review done by a cloud model even when the translation runs
locally: `review.model` is set separately from `translate.model`, and it picks its own
engine by the name it is given — `ollama:qwen3:14b` is local, anything else goes to the
gateway, the same rule `dub compare` uses. A reviewer that does not answer costs you the
review, not the translation: the finished text is kept and the run says why it was not
reviewed.

```yaml
translate:
  engine: ollama              # the draft is written locally
  model: qwen3:8b
  review:
    enabled: true
    model: anthropic/claude-sonnet-4.5   # and read by a cloud model
```

It is one pass per film, cheaper than the translation itself.

The knobs live in `config.yaml`: which checks run (`checks`), the discard threshold
(`max_changes_share`), and the pass size for very long films (`batch_lines`).

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
a speaker with no explicit assignment gets a voice of their own gender.

**When the pitch says nothing, the text does.** Pitch measurement starves on real audio:
only 9% of frames yield a stable pitch, one speaker on episode 3 produced 0.62 seconds of
it, and 171 Hz sits in the middle of the band where the detector refuses to answer. Russian
states gender outright — «я пришёл» is a man speaking, «ты сказала» a woman being addressed.
The clue is independent: the translator is never told who is speaking, only the line's
number, its time and the original, so the gender in the text comes from the scene rather
than from our own measurement. It is collected after S3, when there is a text to read.

The two clues are not equally strong. First person speaks about whoever says the line.
Second person speaks about whoever is addressed, and the pipeline does not always know who
that is: it counts only when the line names a character the viewer has already labelled, or
when exactly one other voice is present in the scene. A verdict needs two agreeing clues and
none against it — one slip should not change a character's voice for the whole film.

The pitch stays a measurement; the text never overwrites it. Pitch is confident — pitch
decides; pitch is silent — the text answers; they disagree — nobody decides, and the dispute
shows in "Voices and characters" along with what it rests on. The review is given both, and
told to leave gender alone where they disagree: it used to correct gender from a wrong
measurement and damage text that was right.

Where the engine's own voices have a measured pitch — as all the silero speakers do — the
choice goes further than gender: an actress gets a voice at *her* pitch rather than "a female
voice". On a real episode the two actresses sit at 195 and 176 Hz and are given speakers at
195 and 177; before that they shared piper's single female voice and blurred into one. A
voice already handed out is not handed out twice. Piper's voices carry no measured pitch, so
there the rotation by gender still applies. Explicit `tts.voice_map` entries and per-video
edits always win over the automatic choice.

### Two synthesis engines

| | piper | silero |
|---|---|---|
| Russian voices | 4, one of them female | 29, sixteen of them female |
| Size | 21 MB + ~60 MB per voice | 92 MB for every voice at once |
| Speed | 0.45 s per line | 0.03 s per line |
| Requires | nothing | Python with `torch` and `soundfile` |
| License | MIT | CC BY-NC-SA 4.0 (non-commercial) |

Measured on the same 136-line episode: piper voiced it in a minute, silero in twelve seconds.

**They also differ in how clearly they finish a line, and that was found by ear.** Piper
swallows a short final word of a short line: «Это всё твоё» comes out as «Это всё тво…», and
so do «Это моё», «Это моя», «Это мой». The letter ё has nothing to do with it — «Это оно» and
«Это она» are the same length and come out clean, and so does «Я сказал, что это твоё». What
gets swallowed is a short possessive pronoun at the end. Silero says the same lines clearly.
Checked against the audio: the clip is whole and neither alignment nor mixing cuts it — that
is how the voice says it.

Pick one with `tts.engine`. Voice names do not overlap between the engines
(`ru_RU-irina-medium` for piper, `ru_zhadyra` for silero), so change `tts.default_voice`
along with the engine — otherwise the configuration is rejected and says so. The silero
speakers read Russian as speakers of other CIS languages, and some of them have an accent.
Piper stays the default because its voices are MIT-licensed, while the silero model is
non-commercial.

To measure the pitch of your own samples with the same code the program uses on actors:

```bash
npx tsx scripts/voice-pitch.mts <directory with wav files> --match 195,176
```

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

`dub doctor` prints what runs where: the adapters it found, each stage and the
device it will use, and what is missing to make something faster.

ROCm on Windows is neither needed nor advised for this: MIOpen compiles its
kernels at run time, the ROCm packages ship no C++ standard headers, and the
compilation fails on every kernel. That is an AMD defect, reproducible on
supported cards too ([ROCm#6150](https://github.com/ROCm/ROCm/issues/6150)).

## Performance

Measured on a Ryzen 7 8745HS with a Radeon 780M integrated GPU, on a 29-minute episode with
Korean speech, `large-v3` for recognition and Sonnet 4.5 for translation:

| Stage | Time | Where |
|---|---|---|
| Recognition, `large-v3` | 13 min 15 s | GPU (Vulkan) |
| Recognition, `small` | 2 min 18 s | GPU (Vulkan) |
| Working out who speaks | 2 min 14 s | GPU (DirectML) |
| the same on the CPU | 17 min 32 s | CPU |
| Translation, 257 lines | 6 min 47 s | the gateway, $0.70 |
| the same on a cheap model | 4 min 5 s | the gateway, $0.017 |
| Separating voice from music | 2 min 21 s | GPU (DirectML) |
| Synthesis | 1 min 9 s | CPU (piper) |
| Fitting | 39 s | CPU (ffmpeg) |
| Mixing and muxing | 1 min 38 s | CPU (ffmpeg) |
| **Whole run** | **23 min 9 s** | |

The speaker breakdown is cached against the recording, so a second run of the same file skips
it entirely. A whole run served from cache takes milliseconds. Subtitles for an already
processed file are written just as fast.

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
| silero `v5_5_ru` (5 accent-free voices) | 138 MB | CC BY-NC-SA 4.0 |
| silero `v5_cis_base` (29 voices) | 92 MB | CC BY-NC-SA 4.0 |
| pyannote diarization (optional) | 38 MB | MIT, gated by a free Hugging Face account |
| MDX-Net separation model (optional) | 67 MB | MIT |

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the details, including what this
means if you package the application yourself.

**On networked synthesis:** there is none. Synthesis runs locally, through `piper` or
`silero`. The unofficial edge-tts client was once listed in the settings but never
implemented, and has been removed: using it violates Microsoft's terms and its limits move
without notice.

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

## How much disk this takes

The pipeline passes uncompressed audio between stages, so the working directory grows fast.
The scratch tracks are deleted after mixing - 585 MB on a 15-minute episode - but each stage's
inputs stay, so a second run does not redo the work. As an order of magnitude: a 15-minute
episode holds about 660 MB, plus the shared models (whisper, pyannote, MDX, voices) at roughly
5 GB for all files together.

The current total is shown under Settings → System beside the clear button, and each file's
own share on its page. Clearing never touches the downloaded programs and models.

To keep the scratch tracks around while working on the sound: `cache.keep_intermediate: true`.

## Development

```bash
npm test              # 362 tests; no ffmpeg, no network and no keys required
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
3. With `separation.apply: everywhere`, songs lose their vocals along with the speech. The
   default — removing the voice only under our own speech — leaves an undubbed song intact.
4. The GPU is used where it pays and only there: recognition through a Vulkan build of
   whisper.cpp (twice as fast, chosen by hand because the project publishes no AMD builds),
   speaker embeddings and voice separation through DirectML. Synthesis, fitting and mixing
   stay on the CPU. ROCm under Windows is not used — MIOpen fails to build its kernels, an
   open AMD defect.
5. Estimating a line's duration is a fitted model — a fixed cost per replica plus characters
   over a rate — measured per voice, not a constant. It is still an estimate: the exact fit is
   done by stage S6 through tempo, borrowed silence and, last of all, shortening.
6. Source languages other than English do run (whisper is multilingual), but several defaults
   assume Latin script: the translation length cap, word joining for languages written without
   spaces, and the subtitle line width.

## License

[MIT](LICENSE) © 2026 Mikhail Sergeev.

The license covers this source code. Downloaded third-party components keep their own
licenses, and the material you process keeps its copyright — see the personal-use notice at
the top of this file.
