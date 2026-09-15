/**
 * Язык сообщений, которые сервер отдаёт интерфейсу (ТЗ §16.5).
 *
 * Интерфейс переводится словарём на странице, но часть текста рождается на
 * сервере: панель готовности, предупреждения стадий, причины отказов. Такие
 * строки приходят готовыми, поэтому язык выбирается здесь — по тому, что
 * прислал интерфейс. Командная строка остаётся русской: там язык не выбирают.
 */

export type UiLanguage = 'ru' | 'en';

export const UI_LANGUAGES: UiLanguage[] = ['ru', 'en'];

export function normalizeLanguage(raw: string | null | undefined): UiLanguage {
  const code = (raw ?? '').slice(0, 2).toLowerCase();
  return code === 'en' ? 'en' : 'ru';
}

const MESSAGES: Record<string, Record<UiLanguage, string>> = {
  // --- панель готовности
  'ready.ffmpeg.title': { ru: 'ffmpeg и ffprobe', en: 'ffmpeg and ffprobe' },
  'ready.ffmpeg.local': { ru: 'загружены в рабочий каталог', en: 'downloaded into the working directory' },
  'ready.ffmpeg.system': { ru: 'найдены в системе', en: 'found in the system' },
  'ready.ffmpeg.missing': { ru: 'не найдены', en: 'not found' },
  'ready.ffmpeg.blocks': {
    ru: 'без них не работает ничего: ни извлечение аудио, ни сведение',
    en: 'nothing works without them: neither audio extraction nor mixing',
  },
  'ready.whisper.title': { ru: 'Распознавание речи — модель {model}', en: 'Speech recognition — {model} model' },
  'ready.whisper.noProgram': { ru: 'нет программы распознавания', en: 'the recognition program is missing' },
  'ready.whisper.noWeights': { ru: 'нет весов модели', en: 'the model weights are missing' },
  'ready.whisper.blocks': {
    ru: 'стадия S2: без неё не будет ни реплик, ни таймкодов',
    en: 'stage S2: without it there are no replicas and no timings',
  },
  'ready.piper.title': { ru: 'Синтез речи — голос {voice}', en: 'Speech synthesis — {voice} voice' },
  'ready.piper.noProgram': { ru: 'нет программы синтеза', en: 'the synthesis program is missing' },
  'ready.piper.noVoice': { ru: 'нет голоса', en: 'the voice is missing' },
  'ready.piper.blocks': { ru: 'стадия S5: без неё не будет озвучки', en: 'stage S5: without it there is no voicing' },
  'ready.silero.title': { ru: 'Синтез речи — голоса silero ({voice})', en: 'Speech synthesis — silero voices ({voice})' },
  'ready.silero.noPython': { ru: 'нет Python — движку silero он нужен', en: 'Python is missing — the silero engine needs it' },
  'ready.silero.noModel': { ru: 'модель голосов не скачана', en: 'the voice model is not downloaded' },
  'ready.silero.willFetch': {
    ru: 'скачается сама при первой озвучке, 92 МБ на все 29 голосов',
    en: 'downloads itself on the first synthesis, 92 MB for all 29 voices',
  },
  'ready.key.title': { ru: 'Ключ доступа к моделям — {env}', en: 'Model access key — {env}' },
  'ready.key.envFallback': { ru: 'переменная', en: 'variable' },
  'ready.key.set': { ru: 'задан, перевод пойдёт через шлюз', en: 'set, translation goes through the gateway' },
  'ready.key.missing': { ru: 'не задан', en: 'not set' },
  'ready.key.notNeeded': { ru: 'не нужен: профиль offline переводит локально', en: 'not needed: the offline profile translates locally' },
  'ready.key.blocks': {
    ru: 'стадия S3: без ключа перевод пойдёт через локальный Ollama, а если его нет — не выполнится вовсе',
    en: 'stage S3: without a key translation falls back to a local Ollama, and fails entirely if there is none',
  },
  'ready.key.hint': {
    ru: 'задайте переменную окружения {env} и перезапустите программу либо переключите профиль на offline в настройках',
    en: 'set the {env} environment variable and restart, or switch the profile to offline in the settings',
  },
  'ready.ytdlp.title': { ru: 'Загрузка видео по ссылке', en: 'Downloading video by link' },
  'ready.ytdlp.missing': { ru: 'не найдена', en: 'not found' },
  'ready.ytdlp.blocks': {
    ru: 'обработка ссылок YouTube; файлы с диска работают и без неё',
    en: 'processing YouTube links; files on disk work without it',
  },
  'ready.diarization.title': { ru: 'Разные голоса для персонажей (диаризация)', en: 'Separate voices per character (diarization)' },
  'ready.diarization.ok': { ru: 'pyannote и веса модели на месте', en: 'pyannote and the model weights are in place' },
  'ready.diarization.blocks': {
    ru: 'стадия S2: все реплики получат один голос',
    en: 'stage S2: every replica gets the same voice',
  },
  'ready.python.title': { ru: 'Отделение голоса от музыки', en: 'Separating voice from music' },
  'ready.python.ok': { ru: 'Python, numpy и onnxruntime на месте', en: 'Python, numpy and onnxruntime are in place' },
  'ready.python.missing': { ru: 'не хватает: {missing}', en: 'missing: {missing}' },
  'ready.python.blocks': {
    ru: 'стадия S4; вместо неё оригинал будет приглушён',
    en: 'stage S4; without it the original is ducked instead',
  },
  'ready.hintFetch': { ru: 'нажмите «Догрузить недостающее»', en: 'press “Download what is missing”' },
  'ready.ready': { ru: 'готово', en: 'ready' },
  'ready.summary.blocked': { ru: 'Не хватает необходимого: {count}', en: 'Missing essentials: {count}' },
  'ready.summary.warnings': { ru: 'Главное на месте, есть замечания: {count}', en: 'The essentials are in place, with notes: {count}' },
  'ready.summary.ok': { ru: 'Всё готово к работе', en: 'Everything is ready' },
  'ready.size.ffmpeg': { ru: '106 МБ', en: '106 MB' },
  'ready.size.whisper': { ru: '20 МБ + 465 МБ веса', en: '20 MB + 465 MB weights' },
  'ready.size.piper': { ru: '21 МБ + 60 МБ голос', en: '21 MB + 60 MB voice' },
  'ready.size.silero': { ru: '92 МБ на все 29 голосов', en: '92 MB for all 29 voices' },
  'ready.size.ytdlp': { ru: '17 МБ', en: '17 MB' },
  'ready.size.diarizationWeights': { ru: '30 МБ веса', en: '30 MB weights' },
  'ready.size.diarizationFull': { ru: '~1 ГБ (PyTorch) + 30 МБ веса', en: '~1 GB (PyTorch) + 30 MB weights' },

  // --- причины недоступности диаризации
  'diarization.noPython': { ru: 'Python не найден', en: 'Python not found' },
  'diarization.noPythonHint': {
    ru: 'Установите Python 3.10+ (python.org) и перезапустите программу',
    en: 'Install Python 3.10+ (python.org) and restart the application',
  },
  'diarization.notInstalled': { ru: 'не установлен pyannote.audio (PyTorch)', en: 'pyannote.audio (PyTorch) is not installed' },
  'diarization.installHint': {
    ru: 'нажмите «Догрузить недостающее» — модули будут установлены автоматически',
    en: 'press “Download what is missing” — the modules install automatically',
  },
  'diarization.noToken': { ru: 'нет токена Hugging Face для загрузки весов', en: 'no Hugging Face token to download the weights' },
  'diarization.tokenHint': {
    ru: 'введите токен в настройках распознавания и нажмите «Догрузить недостающее»',
    en: 'enter the token in the recognition settings and press “Download what is missing”',
  },
  'diarization.noWeights': { ru: 'веса модели ещё не загружены', en: 'the model weights are not downloaded yet' },
};

/** Сообщение по ключу на выбранном языке с подстановкой {переменных}. */
export function message(key: string, lang: UiLanguage = 'ru', values?: Record<string, string | number>): string {
  const entry = MESSAGES[key];
  let text = entry ? entry[lang] : key;
  if (values) {
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
