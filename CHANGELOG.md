# Changelog

**English** · [Русский](CHANGELOG.ru.md)

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org/).

## [Unreleased]

### Recognition quality

- Whisper's invented subtitle boilerplate no longer reaches the dub. On a Korean episode
  it had taken 68 replicas out of 412, and where it appeared, real dialogue was never
  transcribed: 71 boilerplate replicas against 10 genuine ones between 1:02 and 4:31.
  Known captioning formulas are matched by pattern; a looping decoder is caught by the one
  property real speech never has — identical replicas that overlap in time.
- Whisper is no longer fed its own previous text as a prompt, which is what turned one
  invention into minutes of them. Measured on the same five minutes: 44 seconds of
  boilerplate instead of 79.
- `scripts/clean-hallucinations.mts` applies the same rules to a transcript that already
  exists, so a file recognised before this change need not be recognised again.

### Speed

- The speaker embedding network, which is 96% of diarization, runs on any DirectX GPU
  through DirectML: 2m14s instead of 17m32s on a 35-minute episode, with all 441 speaker
  turns identical.
- Voice/music separation runs its mask network on the GPU too: a minute of audio in 3
  seconds instead of 17.
- The speaker breakdown is cached against a fingerprint of the recording, so switching the
  recognition model no longer recomputes it.
- whisper.cpp can be run from a Vulkan build on AMD and Intel GPUs — twice as fast on a
  Radeon 780M, chosen by hand because the archive comes from a third party.

### Robustness

- A batch the translation model refuses costs its own replicas, not the whole stage. An
  untranslated replica keeps its original text only when a Russian voice can read it;
  Hangul and Han characters stay silent instead of becoming noise.
- A run can resume mid-pipeline when some replicas failed to translate: each stage is
  judged by the replicas it was supposed to touch, not by all of them.

### Configuration

- `asr.backend` selects the whisper build: auto, cpu, blas, cuda, vulkan.
- `asr.diarization.device` and `separation.device` select where each stage computes, with
  one shared vocabulary: auto, cpu, gpu, igpu, dgpu, cuda.
- `large-v3-turbo` is offered among the recognition models.

## [1.0.0] — 2026-09-14

First public release. The full pipeline works end to end on real material.

### Dubbing

- Seven-stage pipeline: input and audio extraction, recognition, translation, optional
  voice/music separation, synthesis, time fitting, mixing and muxing.
- Word-level timings from whisper.cpp DTW alignment, refined by silero VAD; boundaries land
  within ±250 ms of real speech.
- Translation written to fit the time slot, with a corrective pass and a cap that keeps a
  translation from growing beyond twice the length of its source.
- Time fitting through tempo and, when needed, LLM shortening; mixing with ducking or with
  the separated background, and two-pass EBU R128 loudness normalisation.
- Resumable cache keyed by input content and stage settings, with fingerprints chained
  between stages.

### Subtitles

- A subtitles-only mode producing two SRT files — the original transcript and the Russian
  translation — laid out by readability rules (line length, duration, gaps, reading speed).
- A subtitle editor with per-cue warnings, timecode and text editing, and preview over the
  video.

### Voices

- Speaker diarization through pyannote, with per-speaker voice assignment.
- Voice gender estimated from the pitch of the original speaker, so speakers get a voice of
  their own gender by default.

### Interface

- Desktop application (Electron) and a browser interface, both served by a local API that
  binds to `127.0.0.1` with a one-time token.
- Folder-based library, per-stage progress with elapsed time, readiness panel that names
  what is missing and downloads it in parallel.
- Review mode: watch the finished file, mark corrections (voice, speaker, translation,
  volumes) and re-mix only what changed.
- Settings as a form, with a searchable catalogue of translation models and a button that
  tests whether the selected model actually translates.
- Immediate cancellation: child processes are killed and model requests aborted; finished
  stages stay cached.

### Command line

- `process`, `config`, `cache`, `doctor`, `models`, `compare`, `ui`, `voices`, `export-srt`,
  `evaluate`, with documented exit codes.

[1.0.0]: https://github.com/danifest751/DubPipe/releases/tag/v1.0.0
