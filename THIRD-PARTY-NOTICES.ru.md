# Сторонние компоненты

[English](THIRD-PARTY-NOTICES.md) · **Русский**

DubPipe распространяется под [лицензией MIT](LICENSE). В репозитории **нет чужих
исполняемых файлов и весов моделей**: они скачиваются с сайтов первоисточников при первом
обращении в локальный каталог (`.dubpipe/tools`, `.dubpipe/models`, а у собранного
приложения — `%APPDATA%/DubPipe`), а на сервере с видеокартой — в каталог сервиса
(по умолчанию `~/dubpipe-worker`) или на том Docker `/data`. Каждый компонент остаётся под
своей лицензией, а загрузка происходит на машине пользователя и по его действию.

## Загружаются во время работы

| Компонент | Назначение | Лицензия | Источник |
|---|---|---|---|
| ffmpeg (сборка gyan.dev) | обработка аудио и видео | GPL/LGPL | https://www.gyan.dev/ffmpeg/builds/ |
| yt-dlp | загрузка видео по ссылке | Unlicense | https://github.com/yt-dlp/yt-dlp |
| whisper.cpp | распознавание речи | MIT | https://github.com/ggml-org/whisper.cpp |
| ggml-модели whisper | веса распознавания | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| silero-vad (ONNX) | детектор речевой активности | MIT | https://github.com/snakers4/silero-vad |
| piper | синтез речи | MIT | https://github.com/rhasspy/piper |
| голоса piper `ru_RU-*` | русские голоса | MIT / CC BY | https://huggingface.co/rhasspy/piper-voices |
| silero TTS `v5_5_ru` | 5 русских голосов без акцента | CC BY-NC-SA 4.0 — **некоммерческая** | https://github.com/snakers4/silero-models |
| silero TTS `v5_cis_base` | 29 русских голосов | CC BY-NC-SA 4.0 — **некоммерческая** | https://github.com/snakers4/silero-models |
| pyannote.audio (ставится через pip) | кто говорит (необязательно) | MIT | https://github.com/pyannote/pyannote-audio |
| pyannote `speaker-diarization-community-1` | веса диаризации (необязательно) | CC BY 4.0 | https://huggingface.co/pyannote/speaker-diarization-community-1 |
| модели faster-whisper `Systran/faster-whisper-*` | веса распознавания для faster-whisper (видеокарта NVIDIA) | MIT | https://huggingface.co/Systran |
| `deepdml/faster-whisper-large-v3-turbo-ct2` | `large-v3-turbo` для faster-whisper; на сервере — ещё и проверка голосов актёров | MIT | https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2 |
| модели UVR MDX-Net | отделение голоса от музыки (необязательно) | MIT | https://huggingface.co/seanghay/uvr_models |

Пайплайн pyannote закрыт условиями использования: чтобы скачать веса, нужен бесплатный
аккаунт Hugging Face и согласие с условиями на странице модели. Токен используется для этой
загрузки; с сервером с видеокартой он ещё и уходит на ваш сервер с каждым запросом
диаризации (см. [SECURITY.ru.md](SECURITY.ru.md)).

## Ставится на сервер с видеокартой (по желанию)

`scripts/server/install-worker.sh` или образ Docker `docker/worker/Dockerfile` ставит это на
машину, где работает `dubpipe-worker`, а не на рабочий компьютер. В поставку DubPipe ничего
из этого не входит.

| Компонент | Зачем | Лицензия | Источник |
|---|---|---|---|
| Ubuntu 24.04 (`ubuntu:24.04`, только образ Docker) | основа образа | у каждого пакета своя лицензия | https://hub.docker.com/_/ubuntu |
| uv (в образе — `ghcr.io/astral-sh/uv:0.12.19`) | менеджер пакетов Python для установки | MIT или Apache-2.0 | https://github.com/astral-sh/uv |
| CPython 3.12 и 3.11 (ставит uv) | Python для сервиса и для X-Voice | PSF-2.0 | https://www.python.org |
| PyTorch, библиотеки CUDA | расчёт на видеокарте | BSD / NVIDIA EULA | https://pytorch.org |
| faster-whisper, CTranslate2 | распознавание на видеокарте | MIT | https://github.com/SYSTRAN/faster-whisper |
| pyannote.audio | диаризация на видеокарте | MIT | https://github.com/pyannote/pyannote-audio |
| onnxruntime-gpu | разделение на видеокарте | MIT | https://github.com/microsoft/onnxruntime |
| X-Voice (`--with-clone`) | голоса актёров | код MIT, веса CC BY-NC 4.0 — **некоммерческая** | https://github.com/sunnyxrxrx/X-Voice, https://huggingface.co/XRXRX/X-Voice |
| DeepFilterNet (зависимость X-Voice) | подавление шума | MIT / Apache-2.0 | https://github.com/Rikorose/DeepFilterNet |
| Vocos 24 кГц | вокодер X-Voice | MIT | https://huggingface.co/charactr/vocos-mel-24khz |
| espeak-ng (собирается из исходников) | текст в фонемы для X-Voice | GPL-3.0 | https://github.com/espeak-ng/espeak-ng |
| fastText `lid.176`, зеркало `julien-c/fasttext-language-id` | определение языка внутри X-Voice | CC BY-SA 4.0 по карточке зеркала; исходная модель — CC BY-SA 3.0 | https://huggingface.co/julien-c/fasttext-language-id, https://fasttext.cc/docs/en/language-identification.html |
| Ollama (образ `ollama/ollama`, только `--profile ollama`) | локальный перевод на сервере | MIT | https://github.com/ollama/ollama |
| Gemma 4 (`gemma4:26b-a4b-it-qat`, скачиваете вы) | модель перевода на сервере по умолчанию | Apache-2.0 | https://ai.google.dev/gemma/docs/gemma_4_license |

Клонирование голоса актёра копирует личную черту реального человека: результат — только
для личного просмотра, как и всё, что делает DubPipe.

## Зависимости проекта

Зависимости npm (`commander`, `yaml`, `zod`, `onnxruntime-node`) и зависимости разработки
(`typescript`, `vitest`, `electron`, `electron-builder`, `tsx`, `@playwright/test`,
`playwright`, `playwright-core`) — под разрешительными
лицензиями MIT, ISC или Apache-2.0. Точный состав и версии — в `package.json` и в выводе
`npm ls --all`.

## Данные в исходном коде

В `src/stages/hallucination-phrases.ts` лежат 89 фраз, которые whisper выдумывает на шуме.
Они взяты из набора данных [sachaarbonel/whisper-hallucinations](https://huggingface.co/datasets/sachaarbonel/whisper-hallucinations)
(лицензия MIT). Отобраны только длинные фразы, которые либо встретились не один раз, либо
называют субтитры, подписку или благодарность за просмотр; причина отбора описана в самом
файле.

## Если вы собираете приложение сами

`npm run app:build` создаёт приложение Electron, в которое входит код этого проекта и сам
Electron (MIT). Ни ffmpeg, ни модели, ни голоса в сборку **не входят** — они загружаются
во время работы, как описано выше.

Если когда-нибудь решите включить ffmpeg в сборку, учтите: распространённые сборки ffmpeg
для Windows — **GPL**, и это меняет лицензионные обязательства для всего дистрибутива.
Берите сборку LGPL или сохраняйте принятую здесь схему загрузки во время работы.

## Материал, который вы обрабатываете

Видео, аудио и полученные дорожки не покрываются никакой лицензией этого репозитория. Они
принадлежат своим правообладателям, а DubPipe предназначен только для личного просмотра —
см. предупреждение в начале [README](README.ru.md).
