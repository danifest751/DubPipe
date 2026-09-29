# dubpipe-worker в Docker

[English](README.md)

Сервис DubPipe для машины с видеокартой NVIDIA, собранный в один образ. Он
берёт на себя тяжёлые стадии конвейера: распознавание речи, разбор по голосам,
отделение голоса от фона, синтез и голоса актёров. Программа DubPipe остаётся
на рабочем компьютере и отдаёт сервису звук по локальной сети.

Образ повторяет то, что ставит `scripts/server/install-worker.sh --with-clone`,
но одной командой и с точными версиями пакетов. Установка без Docker тоже
остаётся — см. «Сервер с видеокартой» в [основном README](../../README.ru.md).

## Что внутри

| Часть | Зачем |
|---|---|
| Окружение сервиса (Python 3.12, torch 2.11 + CUDA 12.8) | faster-whisper, pyannote 4, onnxruntime-gpu, silero |
| Окружение X-Voice (Python 3.11, torch 2.8 + CUDA 12.8) | голоса актёров; его CTranslate2 4.5 несовместим с окружением сервиса |
| espeak-ng, собранный из исходников | фонемы для X-Voice, закреплённая версия |
| `entrypoint.sh` | при первом запуске докачивает веса X-Voice, вокодер, модель проверки голосов и модель языков fastlid |

Версии всех пакетов (около 350) закреплены в `worker.lock.txt` и
`xvoice.lock.txt` — они сняты с работающего сервера. Образ собирается ровно из
проверенной комбинации, а не из того, что окажется на PyPI в день сборки.

Весов моделей в образе нет: они большие, а у X-Voice ещё и некоммерческая
лицензия (CC BY-NC). Всё скачанное хранится на томе `/data` и переживает
пересборку и обновление образа.

## Требования

- Видеокарта NVIDIA с поддержкой CUDA 12.8 (проверено на CMP 50HX, архитектура
  Turing) и драйвер NVIDIA не старее 570.
- **Linux:** Docker Engine с плагином Compose и
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
- **Windows:** Docker Desktop с WSL 2 — видеокарту он пробрасывает сам, ставить
  CUDA в Windows не нужно. Нужен обычный драйвер NVIDIA для Windows.
- Место на диске: около 22 ГБ под образ и 8–10 ГБ под модели на томе.
- Видеопамять: 8 ГБ хватает на любую стадию по отдельности; сервис выполняет
  задачи по одной.

Проверить, что Docker видит видеокарту:

```bash
docker run --rm --gpus all ubuntu nvidia-smi
```

## Установка

Из корня репозитория DubPipe:

```bash
cp docker/worker/.env.example docker/worker/.env    # по желанию, см. «Настройки»
docker compose -f docker/worker/compose.yaml up -d --build
```

Первая сборка идёт около получаса: ставятся два окружения Python и собирается
espeak-ng. Первый запуск ещё несколько минут качает около 3 ГБ весов. Готовность
видна в журнале:

```bash
docker compose -f docker/worker/compose.yaml logs -f worker
# … dubpipe-worker слушает 0.0.0.0:8770, умеет: {'clone': True, 'clone_check': True, …}
```

и по адресу `http://<адрес машины>:8770/health`.

Потом в DubPipe: **Настройки → Вычисления → Сервер с видеокартой** — адрес
машины, либо в `config.yaml`:

```yaml
server:
  host: 192.168.0.70      # адрес машины с контейнером
  worker_port: 8770       # если меняли DUBPIPE_WORKER_PORT
```

**Видеокарта в том же компьютере, что и DubPipe** — тот же контейнер, а в
настройках адрес `127.0.0.1`.

## Настройки

Все — в `docker/worker/.env` (образец — `.env.example`):

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `DUBPIPE_WORKER_PORT` | `8770` | порт сервиса на этой машине |
| `DUBPIPE_CLONE` | `1` | `0` — без голосов актёров, их весов (около 3 ГБ) не качать |
| `DUBPIPE_COMFYUI` | `http://host.docker.internal:8188` | где ComfyUI на этой машине |
| `DUBPIPE_OLLAMA` | `http://host.docker.internal:11434` | где Ollama на этой машине |
| `OLLAMA_PORT` | `11434` | порт Ollama в контейнере (только с `--profile ollama`) |

**ComfyUI и Ollama.** Видеокарта обычно общая: ComfyUI держит в ней последние
модели, Ollama после перевода минутами держит языковую модель. Когда задаче не
хватает памяти, сервис выгружает простаивающий ComfyUI, затем модели Ollama, —
для этого ему нужны их адреса. Идущую генерацию он не трогает. Если их на машине
нет, настройки ни на что не влияют. Чтобы контейнер до них достучался, они должны
слушать не только `127.0.0.1` (у Ollama — `OLLAMA_HOST=0.0.0.0`).

**Своей Ollama нет** — поднимите её рядом в контейнере:

```bash
docker compose -f docker/worker/compose.yaml --profile ollama up -d
docker compose -f docker/worker/compose.yaml exec ollama ollama pull gemma4:26b-a4b-it-qat
```

**Токен Hugging Face** серверу хранить не нужно: DubPipe передаёт его с запросом
разбора по голосам, и сервис один раз качает веса pyannote. Условия модели
[pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
должны быть приняты на Hugging Face, а токен задан в DubPipe (Настройки →
Вычисления → «Токен Hugging Face»).

## Где что лежит

Том `dubpipe-data` смонтирован в `/data`:

| Путь | Что там |
|---|---|
| `/data/models` | веса распознавания, разбора по голосам, разделения, silero, модель проверки голосов |
| `/data/xvoice` | веса X-Voice и вокодер |
| `/data/refs` | образцы голосов, присланные программой |
| `/data/jobs` | файлы текущих задач; через три часа убираются сами |
| `/data/home` | домашний каталог сервиса: кэши библиотек, модель языков fastlid |

Посмотреть, сколько занято: `docker system df -v | grep dubpipe-data`.

## Обновление

После `git pull` в репозитории:

```bash
docker compose -f docker/worker/compose.yaml up -d --build
```

Слои с окружениями пересобираются, только если поменялись `*.lock.txt` или
`Dockerfile`; обновление одних скриптов сервиса занимает секунды. Том с моделями
не трогается.

## Переход со службы systemd

Если сервис уже стоял через `install-worker.sh`, он занимает тот же порт.
Сначала остановите службу, потом поднимите контейнер:

```bash
sudo systemctl disable --now dubpipe-worker
docker compose -f docker/worker/compose.yaml up -d --build
```

Контейнер качает модели на свой том заново — старый каталог
`~/dubpipe-worker` он не использует; когда контейнер проработает, его можно
удалить. Вернуться к службе — `docker compose … down` и
`sudo systemctl enable --now dubpipe-worker`.

Проверить контейнер, не останавливая службу, можно на другом порту:

```bash
DUBPIPE_WORKER_PORT=8771 docker compose -p dubpipe-test -f docker/worker/compose.yaml up -d
```

и в DubPipe указать `server.worker_port: 8771`. Убрать пробный контейнер вместе
с его томом: `docker compose -p dubpipe-test -f docker/worker/compose.yaml down -v`.

## Неполадки

**`could not select device driver "nvidia"`** — не установлен NVIDIA Container
Toolkit или Docker не перезапущен после установки
(`sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`).

**Сервис стартовал без голосов актёров** (`'clone': False` в журнале) — при
первом запуске не скачались веса X-Voice: в журнале выше есть причина.
Перезапустите контейнер, когда появится сеть: `docker compose … restart worker`.

**Разбор по голосам ушёл на рабочий компьютер** с сообщением «нет доступа к
весам модели» — в DubPipe не задан токен Hugging Face или не приняты условия
модели pyannote. При запуске DubPipe из командной строки токен берётся из
переменной `HF_TOKEN`.

**В отчёте прогона «сервер посчитал на процессоре»** — видеопамять занята, и
выгрузить нечего: сервис не видит ComfyUI или Ollama по адресам из `.env`, или
память держит что-то третье. `nvidia-smi` на машине покажет, кто.

**Первая задача каждого вида идёт долго** — сервис качает её модель:
распознаванию нужно 3 ГБ, разделению 64 МБ, silero 230 МБ. Второй раз этого нет.

**Сервис недоступен с другого компьютера** — он отвечает только адресам
локальной сети и VPN (как Ollama рядом); проверьте, что порт открыт в
брандмауэре машины.

**Нужно освободить место** — после экспериментов со сборкой кэш Docker может
занимать десятки гигабайт: `docker builder prune -af`. Образ и том с моделями
при этом не трогаются.

## Удаление

```bash
docker compose -f docker/worker/compose.yaml down        # остановить, модели оставить
docker compose -f docker/worker/compose.yaml down -v     # вместе с томом моделей
docker image rm dubpipe-worker:latest
```
