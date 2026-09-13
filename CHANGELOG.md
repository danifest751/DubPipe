# Changelog

**English** · [Русский](CHANGELOG.ru.md)

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org/).

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
