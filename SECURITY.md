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

- **Without a GPU server** (`server.host` empty) everything runs locally except cloud
  translation. Audio and video never leave the machine.
- In the `hybrid` profile only the **text** of the recognized replicas is sent to the
  translation gateway. In the `offline` profile without a GPU server nothing is sent
  anywhere once the models are downloaded.
- **With a GPU server** (`server.host` set), the stages enabled in `server.stages` send
  data to that machine over plain, **unencrypted HTTP**: the audio track (as FLAC) for
  recognition, diarization and separation; the texts of the lines for synthesis
  (`/v1/tts`) and for actors' voices (`/v1/clone`); for actors' voices also a voice sample
  of each speaker cut from the original, with its original text
  (`PUT /v1/clone/ref/<sha256>`). Local translation goes to the Ollama on that machine, so
  the line texts travel there too; the cloud translation of the `hybrid` profile stays with
  the gateway. Use a server only on a network you trust.
- **Keys** (the translation gateway key, the Hugging Face token) are stored in
  `secrets.json` inside the cache directory, never in `config.yaml`. They are exposed to the
  web interface only as a masked string, never in full, and `config.yaml` stays safe to
  share. The configuration schema rejects a key pasted where a variable name is expected and
  moves it into the key store instead. With a GPU server the Hugging Face token is also sent
  to it in cleartext, in the `X-HF-Token` header of every diarization request, so that the
  server can download the gated weights; the service passes it to the diarization process
  in an environment variable and does not store it.
- **The local server** binds to `127.0.0.1` on a random port, issues a one-time token per
  start, requires that token for every `/api/*` request, and refuses to read or serve paths
  outside the working and cache directories.

## The GPU server service

`dubpipe-worker` (`python/dubpipe_worker.py`) is meant for a machine on your own network,
and its security model is deliberately simple:

- **No password.** It listens on `0.0.0.0:8770` and answers only clients whose address is
  private or loopback by Python's `ipaddress`; everyone else gets 403. Tailscale's IPv4
  addresses (`100.64.0.0/10`) are not private by that definition and are refused as well.
- **Do not expose the port to the internet**, least of all under Docker: a published port
  can make clients appear to come from the private gateway address of the Docker network,
  and then the address filter lets everyone through.
- **Any host on the network may call `POST /v1/free`**, which unloads the models of an idle
  ComfyUI on that machine; a running generation is not touched. A job may also ask the
  service to free GPU memory, which unloads an idle ComfyUI and then the Ollama models.
- **Retention.** Job files (uploaded audio and results) live in `data/jobs` and are removed
  once the client has fetched them, or by a background cleaner after 3 hours. Voice samples
  are **not** cleaned: they stay in `data/refs` until you remove them —
  `~/dubpipe-worker/data/refs` after the install script, `/data/refs` on the `dubpipe-data`
  volume under Docker.
- **Downloads by URL** from the client are accepted only from `https://huggingface.co/` and
  `https://models.silero.ai/`.
- **Ollama on the server** has to listen on the network (`OLLAMA_HOST=0.0.0.0`) for
  translation to reach it, and it has no authentication: anyone on the network can use and
  manage its models. The `--profile ollama` of `docker/worker/compose.yaml` publishes port
  11434 with no address filter at all.

## Known risk areas

These are inherent to what the tool does; they are documented rather than hidden:

- Downloaded components (ffmpeg, models, voices) are fetched over HTTPS from upstream
  sources and are not signature-verified beyond a size check. Pin your own mirrors if that
  matters in your environment.
- The optional diarization stage installs `pyannote.audio` with pip into the active Python
  environment when you press the download button; use a virtual environment if you prefer.
- `scripts/server/install-worker.sh` installs uv, when it is missing, by piping
  `https://astral.sh/uv/install.sh` from the internet into `sh`, and writes a systemd unit
  to `/etc/systemd/system` with sudo (`SKIP_SERVICE=1` skips that step). Read the script
  before running it.
- The Docker image of the service (`docker/worker/Dockerfile`) sets no `USER`: the service
  runs as root inside the container.
- The packaged Windows build is unsigned, so SmartScreen will warn about it.
