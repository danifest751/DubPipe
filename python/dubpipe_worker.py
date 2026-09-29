#!/usr/bin/env python3
"""
Сервис DubPipe на машине с видеокартой.

Конвейер работает на рабочем компьютере, а тяжёлые сети — распознавание,
разбор по голосам, отделение голоса и синтез — отдаёт сюда. Сервис намеренно
тонкий: он не знает ничего о дубляже и запускает те же скрипты из этого
каталога, что и локальный путь (`asr_whisper.py`, `diarize.py`,
`mdx_separate.py`, `silero_tts.py`). Поправка в скрипте одинаково действует и
там и тут.

Протокол — HTTP без зависимостей сверх стандартной библиотеки:

    GET    /health                      что умеет сервис и что с видеокартой
    POST   /v1/asr?model=&language=     тело — звук; ответ — поток событий
    POST   /v1/diarize?model=&max_speakers=
    POST   /v1/separate?model=&url=     тело — WAV 44.1 кГц стерео
    GET    /v1/files/<задача>/<файл>    результат задачи
    DELETE /v1/jobs/<задача>            убрать файлы задачи
    POST   /v1/tts                      JSON {model, url, naming, voice, text, sample_rate} → WAV
    GET    /v1/clone/ref/<хеш>          есть ли образец голоса
    PUT    /v1/clone/ref/<хеш>          положить образец голоса (WAV)
    POST   /v1/clone                    JSON {ref, ref_text, ref_lang, text, duration, steps, check} → WAV;
                                        с check — в заголовке X-Heard услышанное в клипе
    POST   /v1/free                     освободить видеопамять ComfyUI, если он простаивает

Звук принимается в WAV или FLAC; с `out=flac` дорожки-результаты отдаются в
FLAC. С `free=1` сервис перед задачей освобождает видеопамять, если её не
хватает: простаивающий ComfyUI, затем модели Ollama.

Поток событий — по строке JSON: {"event": "queued"|"progress"|"log"|"alive"|
"done"|"error", ...}. Строка "alive" идёт раз в несколько секунд: так сервис
узнаёт, что клиент ушёл (прогон остановлен), и снимает расчёт, а не держит
видеокарту до конца впустую.

Задачи на видеокарте идут по одной: две сети сразу не ускоряют друг друга, а
память у карты общая с ComfyUI и Ollama.
"""
import argparse
import io
import ipaddress
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOCOL = 1
HEARTBEAT_SECONDS = 5
JOB_TTL_SECONDS = 3 * 3600
TTS_IDLE_SECONDS = 600

#: Откуда разрешено качать веса по ссылке от клиента. Сервис слушает локальную
#: сеть, и превращать его в загрузчик чего угодно откуда угодно незачем.
ALLOWED_DOWNLOADS = ("https://huggingface.co/", "https://models.silero.ai/")
NAME = re.compile(r"^[A-Za-z0-9_.:/-]{1,120}$")

state = {
    "data": os.path.join(HERE, "data"),
    "comfyui": "http://127.0.0.1:8188",
    "ollama": "http://127.0.0.1:11434",
    "xvoice": os.path.join(HERE, "xvoice"),
    "capabilities": {},
    "waiting": 0,
    "running": None,
}
gpu_lock = threading.Lock()
state_lock = threading.Lock()


def log(message):
    print(time.strftime("%H:%M:%S"), message, file=sys.stderr, flush=True)


def models_dir(*parts):
    path = os.path.join(state["data"], "models", *parts)
    os.makedirs(os.path.dirname(path) if parts and "." in parts[-1] else path, exist_ok=True)
    return path


def jobs_dir(job=""):
    path = os.path.join(state["data"], "jobs", job)
    os.makedirs(path, exist_ok=True)
    return path


def probe_capabilities():
    """Что сервис может делать: по наличию модулей, без их импорта (он дорогой)."""
    import importlib.util

    has = lambda name: importlib.util.find_spec(name) is not None  # noqa: E731
    xvoice = state["xvoice"]
    return {
        # Голоса актёров — своё окружение X-Voice рядом с сервисом.
        "clone": os.path.isfile(os.path.join(xvoice, ".venv", "bin", "python"))
        and os.path.isdir(os.path.join(xvoice, "X-Voice")),
        # Проверка озвученного распознаванием — тем же faster-whisper, что и ASR.
        "clone_check": has("faster_whisper"),
        "asr": has("faster_whisper"),
        "diarization": has("pyannote.audio") and has("torch"),
        "separation": has("onnxruntime") and has("numpy"),
        "tts": has("torch") and has("soundfile"),
    }


def gpu_status():
    try:
        output = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        name, used, total, load, temperature = [part.strip() for part in output.splitlines()[0].split(",")]
        return {
            "name": name,
            "memory_used_mb": int(used),
            "memory_total_mb": int(total),
            "utilization": int(load),
            "temperature": int(temperature),
        }
    except Exception:  # noqa: BLE001 — сведения для экрана, не повод отказывать
        return None


def download(url, target):
    """Качает веса один раз; незавершённая загрузка не выдаётся за готовую."""
    if os.path.exists(target):
        return target
    if not url or not url.startswith(ALLOWED_DOWNLOADS):
        raise ValueError(f"веса «{os.path.basename(target)}» не скачаны, а ссылка не из разрешённых: {url!r}")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    partial = f"{target}.partial"
    log(f"загрузка {url}")
    with urllib.request.urlopen(url, timeout=600) as response, open(partial, "wb") as handle:
        shutil.copyfileobj(response, handle, 1 << 20)
    os.replace(partial, target)
    return target


def free_comfyui():
    """
    Выгрузить модели ComfyUI из видеопамяти — только если у него нет задач.

    ComfyUI держит последние модели в памяти карты (16 из 20 ГБ после
    генерации), и Ollama с моделью на 15 ГБ тогда уходит считать на процессор.
    Чужую генерацию не трогаем: занят — значит занят.
    """
    base = state["comfyui"].rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}/queue", timeout=5) as response:
            current = json.load(response)
    except Exception as error:  # noqa: BLE001
        return {"freed": False, "reason": f"ComfyUI не отвечает: {type(error).__name__}"}
    if current.get("queue_running") or current.get("queue_pending"):
        return {"freed": False, "reason": "ComfyUI занят генерацией"}
    request = urllib.request.Request(
        f"{base}/free",
        data=json.dumps({"unload_models": True, "free_memory": True}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=30).read()
    except Exception as error:  # noqa: BLE001
        return {"freed": False, "reason": f"ComfyUI не освободил память: {type(error).__name__}"}
    return {"freed": True, "reason": "модели ComfyUI выгружены"}


#: Сколько видеопамяти нужно задаче, МБ, с запасом. Замерено на CMP 50HX:
#: large-v3 в fp16 с поиском по пяти лучам — около 4.5 ГБ.
NEEDS_MB = {"asr": 5500, "diarize": 2500, "separate": 2500, "tts": 1500, "clone": 3000, "check": 2000}


def free_mb():
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
        return int(output.splitlines()[0].strip())
    except Exception:  # noqa: BLE001 — не знаем — не мешаем
        return 1 << 30


def unload_ollama():
    """Выгрузить модели Ollama из видеопамяти; в следующий раз она поднимет их сама."""
    base = state["ollama"].rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}/api/ps", timeout=5) as response:
            loaded = [model["name"] for model in json.load(response).get("models", [])]
    except Exception:  # noqa: BLE001 — Ollama остановлена или не отвечает: и так свободно
        return []
    for name in loaded:
        request = urllib.request.Request(
            f"{base}/api/generate",
            data=json.dumps({"model": name, "keep_alive": 0}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(request, timeout=60).read()
        except Exception:  # noqa: BLE001
            pass
    return loaded


def make_room(kind):
    """
    Освобождает видеопамять под задачу, если её не хватает.

    Без этого задача не падает, а молча уходит на процессор: faster-whisper
    при нехватке памяти считает там, и распознавание эпизода растягивается с
    минуты до десяти. Так и случилось, когда Ollama после перевода ещё держала
    gemma4 на 15 ГБ. Сначала выгружается простаивающий ComfyUI, потом модели
    Ollama — она поднимет их сама при следующем запросе.
    """
    need = NEEDS_MB.get(kind, 2000)
    notes = []
    if free_mb() >= need:
        return notes
    notes.append(free_comfyui()["reason"])
    time.sleep(1)
    if free_mb() >= need:
        return notes
    unloaded = unload_ollama()
    if unloaded:
        time.sleep(2)
        notes.append(f"выгружены модели Ollama: {', '.join(unloaded)}")
    if free_mb() < need:
        notes.append(f"видеопамяти мало даже после освобождения: свободно {free_mb()} МБ из нужных {need}")
    return notes


# --- Передача звука: FLAC вместо WAV ------------------------------------------
#
# Рабочий компьютер может сидеть на 100 Мбит/с: дорожка фильма в WAV — 290 МБ
# туда и дважды столько обратно, минута с лишним на одну передачу. FLAC без
# потерь вдвое меньше. Скрипты читают WAV модулем wave, поэтому здесь FLAC
# разворачивается в WAV и обратно — кусками, без чтения фильма в память.


def is_flac(path):
    with open(path, "rb") as handle:
        return handle.read(4) == b"fLaC"


def convert(source, target, subtype, fmt):
    import soundfile as sf

    info = sf.info(source)
    with sf.SoundFile(target, "w", samplerate=info.samplerate, channels=info.channels, subtype=subtype, format=fmt) as out:
        for block in sf.blocks(source, blocksize=1 << 18, dtype="int16", always_2d=True):
            out.write(block)


# --- Синтез: модели silero держатся в процессе -------------------------------


class Speech:
    """Модели silero на видеокарте. Выгружаются после простоя — память карты общая."""

    def __init__(self):
        self.voices = None
        self.lock = threading.Lock()
        self.used = 0.0

    def get(self):
        if self.voices is None:
            import torch

            sys.path.insert(0, HERE)
            from silero_tts import Voices

            device = "cuda" if torch.cuda.is_available() else "cpu"
            self.voices = Voices(device=device)
            log(f"синтез: модели silero на {device}")
        self.used = time.time()
        return self.voices

    def release_if_idle(self):
        with self.lock:
            if self.voices is not None and time.time() - self.used > TTS_IDLE_SECONDS:
                self.voices = None
                try:
                    import torch

                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
                log("синтез: модели выгружены после простоя")

    def say(self, request):
        import soundfile as sf

        model = request.get("model", "")
        if not NAME.match(model) or "/" in model:
            raise ValueError(f"недопустимое имя модели: {model!r}")
        with self.lock:
            if self.voices is None and request.get("free"):
                for note in make_room("tts"):
                    log(f"синтез: {note}")
            voices = self.get()
            if model not in voices.models:
                path = download(request.get("url"), models_dir("silero", f"{model}.pt"))
                voices.load(model, path, request.get("naming", "ru"))
            audio, rate = voices.say(request)
            buffer = io.BytesIO()
            sf.write(buffer, audio.cpu().numpy(), rate, format="WAV", subtype="PCM_16")
            return buffer.getvalue()


speech = Speech()


# --- Голоса актёров: мост к X-Voice в собственном окружении ------------------

CLONE_IDLE_SECONDS = 600
REF_KEY = re.compile(r"^[0-9a-f]{64}$")


class Clone:
    """
    Процесс clone_bridge.py в окружении X-Voice.

    Поднимается по первой реплике и держит модель, пока идёт озвучка; через
    десять минут простоя завершается и отдаёт видеопамять. Реплики идут по
    одной: модель одна, и параллельные запросы встали бы в её же очередь.
    """

    def __init__(self):
        self.process = None
        self.lock = threading.Lock()
        self.used = 0.0

    def refs_dir(self):
        path = os.path.join(state["data"], "refs")
        os.makedirs(path, exist_ok=True)
        return path

    def start(self, free):
        root = state["xvoice"]
        if free:
            for note in make_room("clone"):
                log(f"голоса актёров: {note}")
        env = dict(os.environ)
        espeak = os.path.join(root, "espeak")
        env["PHONEMIZER_ESPEAK_LIBRARY"] = os.path.join(espeak, "lib", "libespeak-ng.so")
        env["LD_LIBRARY_PATH"] = os.path.join(espeak, "lib") + os.pathsep + env.get("LD_LIBRARY_PATH", "")
        env["PATH"] = os.path.join(espeak, "bin") + os.pathsep + env.get("PATH", "")
        env["HF_HOME"] = os.path.join(root, "hf")
        env["PYTHONIOENCODING"] = "utf-8"
        self.process = subprocess.Popen(
            [os.path.join(root, ".venv", "bin", "python"), os.path.join(HERE, "clone_bridge.py"), os.path.join(root, "X-Voice")],
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=open(os.path.join(state["data"], "clone-bridge.log"), "a", encoding="utf-8"),
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        ready = json.loads(self.process.stdout.readline() or "{}")
        if not ready.get("ready"):
            self.stop()
            raise RuntimeError(ready.get("error") or "мост X-Voice не поднялся (см. data/clone-bridge.log)")
        log(f"голоса актёров: X-Voice загружен за {ready.get('seconds')} с")

    def stop(self):
        if self.process is not None:
            try:
                self.process.kill()
                self.process.wait(timeout=10)
            except Exception:  # noqa: BLE001
                pass
            self.process = None

    def release_if_idle(self):
        with self.lock:
            if self.process is not None and time.time() - self.used > CLONE_IDLE_SECONDS:
                self.stop()
                log("голоса актёров: X-Voice выгружен после простоя")

    def say(self, request):
        ref = request.get("ref", "")
        if not REF_KEY.match(ref):
            raise ValueError("недопустимый ключ образца")
        ref_path = os.path.join(self.refs_dir(), f"{ref}.wav")
        if not os.path.exists(ref_path):
            raise FileNotFoundError(f"образца {ref[:12]}… на сервере нет — загрузите его заново")
        duration = float(request.get("duration", 0))
        if not 0.1 <= duration <= 60:
            raise ValueError(f"недопустимая длительность {duration}")
        handle, out = tempfile.mkstemp(suffix=".wav", dir=state["data"])
        os.close(handle)
        payload = {
            "ref": ref_path,
            "ref_text": str(request.get("ref_text", ""))[:500],
            "ref_lang": str(request.get("ref_lang", "en"))[:8],
            "text": str(request.get("text", ""))[:1000],
            "lang": "ru",
            "duration": duration,
            "steps": int(request.get("steps") or 32),
            "out": out,
        }
        try:
            with self.lock:
                if self.process is None or self.process.poll() is not None:
                    self.start(bool(request.get("free")))
                self.used = time.time()
                self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                self.process.stdin.flush()
                reply = json.loads(self.process.stdout.readline() or '{"ok": false, "error": "мост X-Voice замолчал"}')
                self.used = time.time()
            if not reply.get("ok"):
                raise RuntimeError(reply.get("error") or "X-Voice не озвучил реплику")
            with open(out, "rb") as stream:
                return stream.read()
        finally:
            if os.path.exists(out):
                os.remove(out)


clone = Clone()


# --- Проверка озвученного: что на самом деле звучит в клипе -------------------

CHECK_MODEL = "deepdml/faster-whisper-large-v3-turbo-ct2"


class Listener:
    """
    Распознавание клипов голосами актёров.

    X-Voice иногда ошибается в отдельной реплике: договаривает обрывок образца
    в начале («сейшн, с правительством…»), теряет последнее слово. Клиент
    сверяет услышанное с текстом и при браке озвучивает реплику заново. Модель
    держится в процессе: загрузка стоит секунды, а клип распознаётся за доли
    секунды. Выгружается вместе с X-Voice после простоя.
    """

    def __init__(self):
        self.model = None
        self.lock = threading.Lock()
        self.used = 0.0

    def release_if_idle(self):
        with self.lock:
            if self.model is not None and time.time() - self.used > CLONE_IDLE_SECONDS:
                self.model = None
                try:
                    import torch

                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
                log("проверка голосов: whisper выгружен после простоя")

    def hear(self, audio, free):
        with self.lock:
            if self.model is None:
                if free:
                    for note in make_room("check"):
                        log(f"проверка голосов: {note}")
                # torch подгружает библиотеки CUDA из пакетов pip — без него
                # CTranslate2 их не находит (см. asr_whisper.py).
                import torch
                from faster_whisper import WhisperModel

                cuda = torch.cuda.is_available()
                self.model = WhisperModel(
                    CHECK_MODEL,
                    device="cuda" if cuda else "cpu",
                    compute_type="float16" if cuda else "int8",
                    download_root=models_dir("hf", "hub"),
                )
                log(f"проверка голосов: whisper на {'cuda' if cuda else 'cpu'}")
            segments, _ = self.model.transcribe(
                io.BytesIO(audio), language="ru", beam_size=5, condition_on_previous_text=False, vad_filter=False
            )
            text = " ".join(segment.text.strip() for segment in segments)
            self.used = time.time()
            return text


listener = Listener()


# --- Задачи на скриптах ------------------------------------------------------


def last_error(lines):
    """Скрипты печатают причину отказа JSON-строкой {"error": ...} в stderr."""
    for line in reversed(lines):
        line = line.strip()
        if line.startswith("{"):
            try:
                parsed = json.loads(line)
            except ValueError:
                continue
            if parsed.get("error"):
                return parsed["error"]
    tail = [line.strip() for line in lines if line.strip()]
    return "; ".join(tail[-2:]) or "скрипт завершился с ошибкой"


def plan_job(kind, params, job, source, headers):
    """Команда запуска и файлы-результаты задачи. Параметры проверяются здесь."""
    script = lambda name: os.path.join(HERE, name)  # noqa: E731
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"

    if kind == "asr":
        model = params.get("model", "large-v3-turbo")
        language = params.get("language", "")
        if not NAME.match(model) or (language and not re.match(r"^[a-z]{2,3}$", language)):
            raise ValueError("недопустимые model или language")
        output = os.path.join(job, "asr.json")
        command = [sys.executable, script("asr_whisper.py"), "--input", source, "--output", output, "--model", model]
        if language:
            command += ["--language", language]
        command += ["--cache-dir", models_dir("hf")]
        return command, env, {"asr.json": output}

    if kind == "diarize":
        model = params.get("model", "pyannote/speaker-diarization-community-1")
        speakers = int(params.get("max_speakers", "0") or 0)
        if not NAME.match(model) or not 0 <= speakers <= 32:
            raise ValueError("недопустимые model или max_speakers")
        output = os.path.join(job, "diarization.json")
        cache = models_dir("hf")
        marker = os.path.join(cache, ".ready-" + re.sub(r"[^A-Za-z0-9_.-]+", "_", model))
        command = [
            sys.executable, script("diarize.py"),
            "--input", source, "--output", output,
            "--model", model, "--max-speakers", str(speakers),
            "--cache-dir", cache, "--token-env", "HF_TOKEN", "--device", "cuda",
        ]
        token = headers.get("X-HF-Token")
        if token:
            env["HF_TOKEN"] = token
        if os.path.exists(marker):
            command.append("--offline")
        return command, env, {"diarization.json": output, "_marker": marker}

    if kind == "separate":
        model = params.get("model", "")
        if not re.match(r"^[A-Za-z0-9_.-]{1,80}$", model):
            raise ValueError("недопустимое имя модели разделения")
        weights = download(params.get("url"), models_dir("mdx", f"{model}.onnx"))
        instrumental = os.path.join(job, "instrumental.wav")
        vocals = os.path.join(job, "vocals.wav")
        command = [
            sys.executable, script("mdx_separate.py"),
            "--model", weights, "--input", source,
            "--output-instrumental", instrumental, "--output-vocals", vocals,
            "--device", "cuda",
        ]
        return command, env, {"instrumental.wav": instrumental, "vocals.wav": vocals}

    raise ValueError(f"неизвестная задача: {kind}")


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0: ответ-поток заканчивается закрытием соединения, без длины заранее.
    protocol_version = "HTTP/1.0"
    server_version = "dubpipe-worker"

    def log_message(self, fmt, *args):  # noqa: D401 — тише стандартного журнала
        pass

    # --- ответы ---

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def event(self, payload):
        self.wfile.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self.wfile.flush()

    def allowed(self):
        """Только локальная сеть и VPN: сервис без пароля, как Ollama и Speaches рядом."""
        try:
            address = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return False
        if address.is_private or address.is_loopback:
            return True
        self.send_json(403, {"error": "сервис доступен только из локальной сети"})
        return False

    # --- маршруты ---

    def do_GET(self):
        if not self.allowed():
            return
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            with state_lock:
                busy = {"running": state["running"], "waiting": state["waiting"]}
            self.send_json(
                200,
                {
                    "ok": True,
                    "service": "dubpipe-worker",
                    "protocol": PROTOCOL,
                    "capabilities": state["capabilities"],
                    "gpu": gpu_status(),
                    **busy,
                },
            )
            return
        match = re.match(r"^/v1/clone/ref/([0-9a-f]{64})$", path)
        if match:
            exists = os.path.exists(os.path.join(clone.refs_dir(), f"{match.group(1)}.wav"))
            self.send_json(200 if exists else 404, {"exists": exists})
            return
        match = re.match(r"^/v1/files/([0-9a-f]{32})/([A-Za-z0-9_.-]+)$", path)
        if match:
            target = os.path.join(jobs_dir(), match.group(1), match.group(2))
            if not os.path.isfile(target):
                self.send_json(404, {"error": "файла нет"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(os.path.getsize(target)))
            self.end_headers()
            with open(target, "rb") as handle:
                shutil.copyfileobj(handle, self.wfile, 1 << 20)
            return
        self.send_json(404, {"error": "нет такого адреса"})

    def do_PUT(self):
        if not self.allowed():
            return
        match = re.match(r"^/v1/clone/ref/([0-9a-f]{64})$", urllib.parse.urlparse(self.path).path)
        if not match:
            self.send_json(404, {"error": "нет такого адреса"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 20 * 1024 * 1024:
            self.send_json(400, {"error": "образец голоса — WAV до 20 МБ"})
            return
        target = os.path.join(clone.refs_dir(), f"{match.group(1)}.wav")
        partial = f"{target}.partial"
        try:
            self.read_body(partial)
            os.replace(partial, target)
        except Exception as error:  # noqa: BLE001
            if os.path.exists(partial):
                os.remove(partial)
            self.send_json(400, {"error": str(error)})
            return
        self.send_json(200, {"ok": True})

    def do_DELETE(self):
        if not self.allowed():
            return
        match = re.match(r"^/v1/jobs/([0-9a-f]{32})$", urllib.parse.urlparse(self.path).path)
        if not match:
            self.send_json(404, {"error": "нет такого адреса"})
            return
        shutil.rmtree(os.path.join(jobs_dir(), match.group(1)), ignore_errors=True)
        self.send_json(200, {"ok": True})

    def do_POST(self):
        if not self.allowed():
            return
        parsed = urllib.parse.urlparse(self.path)
        params = {key: values[-1] for key, values in urllib.parse.parse_qs(parsed.query).items()}
        if parsed.path == "/v1/free":
            self.send_json(200, free_comfyui())
            return
        if parsed.path == "/v1/tts":
            self.tts()
            return
        if parsed.path == "/v1/clone":
            self.clone()
            return
        match = re.match(r"^/v1/(asr|diarize|separate)$", parsed.path)
        if not match:
            self.send_json(404, {"error": "нет такого адреса"})
            return
        self.job(match.group(1), params)

    def read_body(self, target):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("пустое тело запроса: нужен файл")
        remaining = length
        with open(target, "wb") as handle:
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    raise ValueError("файл пришёл не целиком")
                handle.write(chunk)
                remaining -= len(chunk)

    def tts(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            request = json.loads(self.rfile.read(length) or b"{}")
            audio = speech.say(request)
        except Exception as error:  # noqa: BLE001 — причина уходит клиенту
            self.send_json(422, {"error": f"{type(error).__name__}: {error}"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def clone(self):
        if not state["capabilities"].get("clone"):
            self.send_json(501, {"error": "на сервере не установлен X-Voice (scripts/server/install-worker.sh --with-clone)"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            request = json.loads(self.rfile.read(length) or b"{}")
            audio = clone.say(request)
        except Exception as error:  # noqa: BLE001 — причина уходит клиенту
            self.send_json(422, {"error": f"{type(error).__name__}: {error}"})
            return
        heard = None
        if request.get("check") and state["capabilities"].get("clone_check"):
            try:
                heard = listener.hear(audio, bool(request.get("free")))
            except Exception as error:  # noqa: BLE001 — не проверили — не беда: клип всё равно есть
                log(f"проверка голосов: {type(error).__name__}: {error}")
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        if heard is not None:
            # Заголовки HTTP — латиница: русский текст уходит в процентной записи.
            self.send_header("X-Heard", urllib.parse.quote(heard[:2000]))
        self.end_headers()
        self.wfile.write(audio)

    def job(self, kind, params):
        job_id = uuid.uuid4().hex
        job = jobs_dir(job_id)
        source = os.path.join(job, "input" + (".wav" if kind != "asr" else ".audio"))
        try:
            self.read_body(source)
        except Exception as error:  # noqa: BLE001
            shutil.rmtree(job, ignore_errors=True)
            self.send_json(400, {"error": str(error)})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        try:
            self.event({"event": "accepted", "job": job_id})
            with state_lock:
                state["waiting"] += 1
            try:
                # Ждём очереди, не теряя связи с клиентом: ушёл — снимаемся.
                while not gpu_lock.acquire(timeout=HEARTBEAT_SECONDS):
                    self.event({"event": "queued", "running": state["running"]})
            finally:
                with state_lock:
                    state["waiting"] -= 1
            try:
                with state_lock:
                    state["running"] = kind
                if params.get("free") == "1":
                    for note in make_room(kind):
                        self.event({"event": "log", "text": note})
                if kind != "asr" and is_flac(source):
                    unpacked = os.path.join(job, "input-unpacked.wav")
                    convert(source, unpacked, "PCM_16", "WAV")
                    os.replace(unpacked, source)
                self.run_script(kind, params, job_id, job, source)
            finally:
                with state_lock:
                    state["running"] = None
                gpu_lock.release()
        except (BrokenPipeError, ConnectionResetError):
            log(f"{kind} {job_id[:8]}: клиент ушёл, задача снята")
            shutil.rmtree(job, ignore_errors=True)

    def run_script(self, kind, params, job_id, job, source):
        try:
            command, env, outputs = plan_job(kind, params, job, source, self.headers)
        except Exception as error:  # noqa: BLE001
            self.event({"event": "error", "error": str(error)})
            shutil.rmtree(job, ignore_errors=True)
            return

        marker = outputs.pop("_marker", None)
        started = time.time()
        log(f"{kind} {job_id[:8]}: старт")
        process = subprocess.Popen(
            command,
            cwd=HERE,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            # Своя группа процессов — чтобы снять расчёт целиком, с детьми.
            **({"start_new_session": True} if os.name == "posix" else {}),
        )
        lines = queue.Queue()
        seen = []

        def pump():
            for line in process.stderr:
                lines.put(line)
            lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        try:
            last_beat = time.time()
            while True:
                try:
                    line = lines.get(timeout=1)
                except queue.Empty:
                    line = ""
                if line is None:
                    break
                if line:
                    seen.append(line)
                    del seen[:-50]
                    progress = re.search(r"progress=(\d+)", line)
                    if progress:
                        self.event({"event": "progress", "percent": int(progress.group(1))})
                    elif not line.lstrip().startswith("{") and "warn" not in line.lower():
                        self.event({"event": "log", "text": line.strip()[:300]})
                    last_beat = time.time()
                elif time.time() - last_beat >= HEARTBEAT_SECONDS:
                    self.event({"event": "alive"})
                    last_beat = time.time()
            code = process.wait()
        except BaseException:
            # Клиент ушёл посреди расчёта: не держать видеокарту ради никого.
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except Exception:  # noqa: BLE001
                process.kill()
            process.wait()
            raise

        seconds = round(time.time() - started, 1)
        if code != 0:
            error = last_error(seen)
            log(f"{kind} {job_id[:8]}: ошибка за {seconds} с: {error}")
            self.event({"event": "error", "error": error, "seconds": seconds})
            shutil.rmtree(job, ignore_errors=True)
            return

        if marker:
            with open(marker, "w", encoding="utf-8") as handle:
                handle.write(time.strftime("%Y-%m-%dT%H:%M:%S"))
        if params.get("out") == "flac":
            # Результаты-дорожки — обратно сжатыми: тот же выигрыш, что и на входе.
            for name, path in list(outputs.items()):
                if path.endswith(".wav") and os.path.exists(path):
                    packed = path[: -len(".wav")] + ".flac"
                    convert(path, packed, "PCM_16", "FLAC")
                    os.remove(path)
                    outputs[name] = packed
        files = {name: f"/v1/files/{job_id}/{os.path.basename(path)}" for name, path in outputs.items() if os.path.exists(path)}
        result = None
        json_outputs = [path for path in outputs.values() if path.endswith(".json") and os.path.exists(path)]
        if json_outputs:
            with open(json_outputs[0], encoding="utf-8") as handle:
                result = json.load(handle)
        log(f"{kind} {job_id[:8]}: готово за {seconds} с")
        self.event({"event": "done", "job": job_id, "seconds": seconds, "result": result, "files": files})
        if result is not None and len(files) == len(json_outputs):
            # Всё отдано в самом событии — хранить файлы незачем.
            shutil.rmtree(job, ignore_errors=True)
        else:
            os.remove(source) if os.path.exists(source) else None


def janitor():
    """Убирает брошенные задачи и выгружает простаивающий синтез."""
    while True:
        time.sleep(60)
        speech.release_if_idle()
        clone.release_if_idle()
        listener.release_if_idle()
        root = jobs_dir()
        for name in os.listdir(root):
            path = os.path.join(root, name)
            try:
                if time.time() - os.path.getmtime(path) > JOB_TTL_SECONDS:
                    shutil.rmtree(path, ignore_errors=True)
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser(description="Сервис DubPipe для машины с видеокартой")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--data", default=os.path.join(HERE, "data"))
    parser.add_argument("--comfyui", default="http://127.0.0.1:8188")
    parser.add_argument("--ollama", default="http://127.0.0.1:11434")
    parser.add_argument("--xvoice", default=os.path.join(HERE, "xvoice"), help="каталог X-Voice: .venv, X-Voice, espeak")
    args = parser.parse_args()

    state["data"] = os.path.abspath(args.data)
    state["comfyui"] = args.comfyui
    state["ollama"] = args.ollama
    state["xvoice"] = os.path.abspath(args.xvoice)
    state["capabilities"] = probe_capabilities()
    jobs_dir()
    threading.Thread(target=janitor, daemon=True).start()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    log(f"dubpipe-worker слушает {args.host}:{args.port}, умеет: {state['capabilities']}")
    server.serve_forever()


if __name__ == "__main__":
    main()
