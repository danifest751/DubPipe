# Contributing

**English** · [Русский](CONTRIBUTING.ru.md)

Thanks for taking the time. This is a small project with a clear shape, so a short set of
rules keeps it that way.

## Getting set up

```bash
npm install
npm run typecheck
npm test            # 263 tests; no ffmpeg, no network and no API keys needed
```

The tests deliberately need nothing external: if a change forces a test to require ffmpeg,
the network or a key, the test is in the wrong place — move that part behind a script in
`scripts/`.

To run the tool itself without building:

```bash
npx tsx src/cli.ts doctor --fetch   # fetch the external components first
npx tsx src/cli.ts ui
```

## How the code is laid out

```
src/core/       pipeline, workspace, cache, cancellation, logging
src/stages/     s1…s7 and subtitles — one file per stage
src/providers/  asr, llm, tts, vad, diarization — one folder per kind
src/ui/         local API server and the web interface (src/ui/public)
src/util/       ffmpeg, downloads, process execution, wav/srt helpers
python/         optional sidecars: separation and diarization
scripts/        checks that need real media, a window or the network
tests/          vitest, offline only
```

A stage reads and writes `segments.json` through `Workspace` and reports progress through
`log`. If you add a stage-level operation, keep that contract: it is what gives the project
caching, progress bars and cancellation for free.

## Pull requests

- **One change per pull request.** A bug fix and a refactor in one diff is two reviews.
- **Add a test that fails without your change.** Tests live next to the rules they protect;
  see `tests/subtitles.test.ts` for the style — a test per rule, named in plain language.
- Run `npm run typecheck` and `npm test` before pushing. TypeScript runs in strict mode.
- Keep comments explaining *why*, not *what*. Existing comments are in Russian in the parts
  that were written for the Russian-speaking author and in English elsewhere; write new ones
  in whichever language the surrounding file uses.
- If you change behaviour visible to the user, update both READMEs (`README.md` is the
  primary one, `README.ru.md` mirrors it).
- If you change something that was measured — timings, quality, thresholds — say what you
  measured and on what material. Numbers in this project come from real runs, not estimates.

## Reporting bugs

Include the version, your OS, what you ran and what happened. The single most useful
attachment is `run.log` from the working directory of the file you processed — it records
every stage of every run. Please remove anything private from it first, and never attach
API keys.

## What will not be accepted

- Any feature that uploads, publishes or distributes the produced track. The tool is for
  private copying; this is a deliberate boundary, not an oversight.
- Bundling third-party binaries into the repository. They are downloaded at runtime, which
  keeps the licensing clean — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Heuristic "pseudo-diarization" from signal features instead of a real model: it produces
  unstable voice assignment between scenes.

## Code of conduct

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
