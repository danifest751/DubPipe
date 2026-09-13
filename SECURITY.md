# Security policy

**English** · [Русский](SECURITY.ru.md)

## Reporting a vulnerability

Please report security issues **privately**, not through public issues.

- Use GitHub's [private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" on the Security tab).
- Include what you did, what happened and what you expected; a minimal reproduction helps most.
- Expect a first response within about a week. This is a hobby project maintained by one
  person, so please be patient.

Please do not include real API keys, tokens or personal video material in a report. If a key
is involved, revoke it first and describe the situation instead.

## Supported versions

The latest release on `main` is the supported version. Older versions receive no fixes.

## What the tool does with your data

- **Everything runs locally** except translation. Audio and video never leave the machine.
- In the `hybrid` profile only the **text** of the recognized replicas is sent to the
  translation gateway. In the `offline` profile nothing is sent anywhere once the models are
  downloaded.
- **Keys** (the translation gateway key, the Hugging Face token) are stored in
  `secrets.json` inside the cache directory, never in `config.yaml`. They are exposed to the
  web interface only as a masked string, never in full, and `config.yaml` stays safe to
  share. The configuration schema rejects a key pasted where a variable name is expected and
  moves it into the key store instead.
- **The local server** binds to `127.0.0.1` on a random port, issues a one-time token per
  start, requires that token for every `/api/*` request, and refuses to read or serve paths
  outside the working and cache directories.

## Known risk areas

These are inherent to what the tool does; they are documented rather than hidden:

- Downloaded components (ffmpeg, models, voices) are fetched over HTTPS from upstream
  sources and are not signature-verified beyond a size check. Pin your own mirrors if that
  matters in your environment.
- The optional diarization stage installs `pyannote.audio` with pip into the active Python
  environment when you press the download button; use a virtual environment if you prefer.
- The packaged Windows build is unsigned, so SmartScreen will warn about it.
