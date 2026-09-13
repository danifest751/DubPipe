# Сторонние компоненты

[English](THIRD-PARTY-NOTICES.md) · **Русский**

DubPipe распространяется под [лицензией MIT](LICENSE). В репозитории **нет чужих
исполняемых файлов и весов моделей**: они скачиваются с сайтов первоисточников при первом
обращении в локальный каталог (`.dubpipe/tools`, `.dubpipe/models`, а у собранного
приложения — `%APPDATA%/DubPipe`). Каждый компонент остаётся под своей лицензией, а загрузка
происходит на машине пользователя и по его действию.

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
| pyannote speaker diarization | кто говорит (необязательно) | MIT | https://huggingface.co/pyannote |
| модели UVR MDX-Net | отделение голоса от музыки (необязательно) | MIT | https://huggingface.co/seanghay/uvr_models |

Пайплайн pyannote закрыт условиями использования: чтобы скачать веса, нужен бесплатный
аккаунт Hugging Face и согласие с условиями на странице модели. Токен используется только
для этой загрузки.

## Зависимости проекта

Зависимости npm (`commander`, `yaml`, `zod`, `onnxruntime-node`) и зависимости разработки
(`typescript`, `vitest`, `electron`, `electron-builder`, `tsx`) — под разрешительными
лицензиями MIT, ISC или Apache-2.0. Точный состав и версии — в `package.json` и в выводе
`npm ls --all`.

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
