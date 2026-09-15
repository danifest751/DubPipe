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
- 89 formulas collected by others from noise-only recordings were added to the filter,
  taken from an MIT dataset of 7889 and narrowed to the long ones that name subtitles or
  subscriptions — the raw list starts with "bye" and "you" and would cut real dialogue.
- `scripts/clean-hallucinations.mts` applies the same rules to a transcript that already
  exists, so a file recognised before this change need not be recognised again.

### Sound

- Fitting no longer laid replicas over their neighbours on every second run. The length of
  the fitted clip was written over the length of the synthesis it was computed from, so a
  re-run planned from its own output, chose no speed-up at all and rendered clips that did
  not fit the time they were given.
- The original voice no longer comes back in the gaps between replicas. Lines are 50 ms
  apart by default and a transition lasts 120, so the envelope released the original
  between every pair of them — under continuous dubbed speech the original actor was
  audible in each gap.
- A quiet trace of the original voice is left under the Russian speech, -12 dB by default,
  chosen by ear: removing it completely made the scene sterile, because breath and the room
  go with the voice.
- The original voice is removed only where the Russian speech plays, instead of ducking the
  whole original track: the music no longer dips under every line, and a song that is not
  dubbed keeps its vocals.
- Fitting borrows the silence that follows a replica instead of asking the model to rewrite
  it shorter. On a 35-minute Korean episode: 52 rewritten replicas became 1, 114 sped-up
  became 9, the largest drift fell from 1357 ms to 330 ms.

### Subtitles

- Russian subtitles follow the Russian voice. Fitting may shift a line by up to 1.5 s, and
  the subtitle stayed where the original had been spoken.

### Length control

- Translation orders a line by the room it really has — its own slot plus the pause fitting
  is allowed to borrow — and every place that judges a line uses that same ruler: the
  corrective pass, the run summary, the shortening prompt, the replica table in the
  interface and the model comparison. Measuring it differently in different places was the
  single largest source of defects in this pipeline.
- A line's duration is modelled as a fixed cost per replica plus characters over a rate,
  fitted per voice instead of assumed. On one voice: 0.51 s and 17.8 characters per second,
  against the 11.5 the pipeline had been aiming at — long lines were being asked for a third
  less text than they could hold.
- The measurement is remembered per voice, so the first run of the next video aims correctly.
- Re-translating a file now re-voices it. Cache freshness was decided by settings alone, so a
  second translation left the audio of the first while the subtitles were rewritten.

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

- A clip is re-voiced when anything it was made from changes: the text, the voice, or the
  sample rate it is rendered at.
- Changing how much of the following pause fitting may borrow re-translates the file, since
  that is what decides the length the translation is ordered at.
- A batch the translation model refuses costs its own replicas, not the whole stage. An
  untranslated replica keeps its original text only when a Russian voice can read it;
  Hangul and Han characters stay silent instead of becoming noise.
- A run can resume mid-pipeline when some replicas failed to translate: each stage is
  judged by the replicas it was supposed to touch, not by all of them.

### Translation

- A final review pass: one look at the whole translation at once, with each speaker's gender,
  the character names and the glossary. Translation runs in batches of ten lines and never
  sees the film, so a name spelled three ways, masculine verbs for a female character and
  formal address mixed with informal are invisible inside a batch. Off by default: it is
  another pass the size of the translation itself.
- Its edits go through the same fit ruler the translation and the length pass use: an edit
  that fits worse is rejected. On a real episode the guard rejected 27 of 46 proposals -
  without it, "improving the style" would have broken the timing on every second line.
- A review that rewrites more than half the lines is discarded whole: that is a
  retranslation, not an edit. The threshold is configurable and does not apply to short
  pieces, where a share means nothing.
- Corrected text reaches the Russian subtitles too: they are built from the same
  `segments.json` as the voicing.
- Each check is switched on separately: gender, glossary, address, consistency, meaning,
  length. The review model is separate as well, so a local translation can be reviewed by a
  cloud one.

### Local translation

- The `offline` profile finally works out of the box. It switched the engine to Ollama but
  left `translate.model` holding a gateway name Ollama has never heard of, and hid the model
  row in that very profile, so there was nothing to fix it with. The profile now fills both
  engine and model, and the field is visible in both profiles, listing what is pulled locally.
- Reasoning is switched off for models like qwen3. On a task whose answer is JSON it is pure
  waste: one batch of ten lines took 800 s with thinking and 25 s without.
- The response schema goes with the request instead of a bare "return JSON". Valid JSON with
  no `items` array was discarded wholesale - qwen3:4b lost all eleven batches that way. With
  the schema the same model on the same input answers correctly.
- Readiness asks the Ollama daemon whether the chosen model is actually pulled, rather than
  asking about a cloud key that offline does not need.
- The README covers setting local translation up: what to install, what to expect of the
  speed, and why an integrated GPU needs `OLLAMA_IGPU_ENABLE=1`.

### Reliability, and an interface that says what it knows

- A partly downloaded file is no longer dubbed in silence. The extracted audio is compared
  against the declared length: more than a second and a percent short warns, more than a
  quarter refuses. The real case: an episode announced 28 minutes, decoded to 7.6, and the
  pipeline confidently dubbed a quarter of the film.
- The working directory stops hoarding scratch audio. Voice, presence, mixed and normalized
  tracks are deleted after muxing - 585 MB of 1.3 GB on a 15-minute episode, measured by
  re-running the stage. `cache.keep_intermediate` brings them back.
- Cache size is visible: the total beside the clear button, each file's own share on its page.
  20 GB had accumulated with no signal other than a full disk.
- The price of a translation is shown before the run, not only in the log afterwards. It is
  computed from the tokens-per-character ratio measured on earlier runs of that model; with no
  such measurement, no number is shown at all. What a file has cost accumulates in meta.json.
- `--from-stage` does what it says: the named stage and everything after it run again. It used
  to force only the stage it named, so "start from s1" re-read the video and touched nothing else.
- `--yes` stopped being an empty flag: anything longer than three hours asks before it takes
  hours of machine time and real money.
- Voices assigned to a video by hand in overrides.json are finally noticed; editing that file
  changed nothing before, because it was not part of the synthesis fingerprint.
- Readiness asks the chosen synthesis engine rather than always piper, and for silero it checks
  for torch, not merely for Python.
- The synthesis engine is selectable in the settings. It used to be reachable only by editing
  config.yaml, and the app keeps its own copy in %APPDATA%.
- The translation field in Review wraps. It was one line with a horizontal scrollbar - the main
  tool for fixing a dub and the most awkward control on the screen.
- The per-speaker voice list shows as many rows as diarization may produce, not always two.
- Run warnings are translated: 27 of them were composed as Russian sentences, so the English
  interface came with English headings and Russian warnings.
- The settings are fully translated: two headings, the first tab, five notes and the slider
  labels were still Russian. The check-i18n guard could not see them - it looked for
  untranslated keys, not hard-coded text; it now looks for both.

### Voices

- A `silero` synthesis engine: 29 Russian speakers in a single 92 MB model, sixteen of them
  female. Piper has exactly one Russian female voice, so two actresses in one film sounded
  the same; now each gets her own.
- Voices are matched by the speaker's pitch, not by gender alone. Every silero speaker has a
  measured pitch, taken with the same code the program uses on actors, so an actress gets a
  voice at her own height: on a real episode the two actresses at 195 and 176 Hz were given
  speakers at 195 and 177. A voice already handed out is not handed out twice.
- `scripts/voice-pitch.mts` measures the pitch of any samples with that same ruler; the voice
  catalogue was built with it.
- The silero model is loaded once per stage and kept in a sidecar process: importing torch
  costs seconds while synthesising one line costs thirty milliseconds. A 136-line episode is
  voiced in twelve seconds against a minute with piper.
- The readiness screen and the voice list now ask the engine that will actually do the work.
  They used to check piper unconditionally, so another engine was reported as "voice missing"
  for a voice that engine never had, and the picker offered names from the wrong catalogue.
- The configuration refuses a voice name from another engine's catalogue and says what the
  chosen engine's voices are called.

### Configuration

- Engines that never existed are gone from the settings: `separation.engine: demucs`,
  `asr.engine: xenova-whisper` and `tts.engine: edge-tts`. All three were offered and all three
  threw. With xenova-whisper went `@xenova/transformers`, the source of every runtime
  vulnerability in the project: `npm audit` is clean now.
- `demucs` is gone from `separation.engine`: it was listed among the accepted values but was
  never implemented, so the stage failed on it. Separation runs through MDX-Net, which
  computes on the GPU through onnxruntime; demucs needs PyTorch and would fall back to the
  CPU on a machine without CUDA.
- `tts.engine` accepts `silero` alongside `piper`.
- `cache.keep_intermediate` keeps the scratch mixing tracks on disk.
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
