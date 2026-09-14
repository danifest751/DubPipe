/**
 * Язык интерфейса (ТЗ §16.5).
 *
 * Программа дублирует на русский, но пользоваться ею могут и те, кто русского
 * не знает: исходный язык — любой. Поэтому интерфейс живёт на двух языках,
 * а выбор хранится рядом с названием программы.
 *
 * Правила словаря:
 *   — ключ описывает место и смысл: `project.dub`, а не `button1`;
 *   — подстановки в фигурных скобках: t('subs.summary', { count: 12 });
 *   — нет ключа — возвращается сам ключ, чтобы пропажа была заметна сразу.
 */

const DICTIONARY = {
  // --- оболочка
  'nav.library': { ru: 'Видео', en: 'Videos' },
  'nav.settings': { ru: 'Настройки', en: 'Settings' },
  'nav.environment': { ru: 'Окружение', en: 'Environment' },
  'lang.label': { ru: 'Язык интерфейса', en: 'Interface language' },

  // --- библиотека
  'library.title': { ru: 'Видео', en: 'Videos' },
  'library.lead': {
    ru: 'Выберите папку — файлы появятся списком. Нажмите «Дублировать», и через несколько минут рядом появится озвученная копия.',
    en: 'Pick a folder and the files show up as a list. Press Dub, and a voiced copy appears next to the original in a few minutes.',
  },
  'library.folder': { ru: 'Папка с видео', en: 'Video folder' },
  'library.pickFolder': { ru: 'Выбрать папку', en: 'Choose folder' },
  'library.refresh': { ru: 'Обновить', en: 'Refresh' },
  'library.other': { ru: 'Другой файл или ссылка', en: 'Another file or link' },
  'library.empty': {
    ru: 'В этой папке нет видеофайлов. Выберите другую папку или откройте файл по пути.',
    en: 'No video files in this folder. Pick another folder, or open a file by path.',
  },
  'library.dub': { ru: 'Дублировать', en: 'Dub' },
  'library.subtitles': { ru: 'Субтитры', en: 'Subtitles' },
  'library.subtitlesHint': {
    ru: 'Распознать речь, перевести и записать два файла SRT',
    en: 'Recognize speech, translate and write two SRT files',
  },
  'library.open': { ru: 'Открыть', en: 'Open' },
  'library.recent': { ru: 'Недавние', en: 'Recent' },
  'library.state.dubbed': { ru: 'озвучено', en: 'dubbed' },
  'library.state.partial': { ru: 'частично: {stages}', en: 'partial: {stages}' },
  'library.state.fresh': { ru: 'не обработан', en: 'not processed' },

  // --- страница файла
  'project.back': { ru: 'Все видео', en: 'All videos' },
  'project.dub': { ru: 'Дублировать', en: 'Dub' },
  'project.stop': { ru: 'Остановить', en: 'Stop' },
  'project.advanced': { ru: 'Дополнительно', en: 'Advanced' },
  'project.fromStage': { ru: 'Со стадии', en: 'From stage' },
  'project.toStage': { ru: 'По стадию', en: 'To stage' },
  'project.modelOnce': { ru: 'Модель перевода на этот раз', en: 'Translation model for this run' },
  'project.modelOnce.placeholder': { ru: 'из настроек', en: 'from settings' },
  'project.outPlace': { ru: 'Куда сохранить итог', en: 'Where to save the result' },
  'project.outBeside': { ru: 'Рядом с исходным файлом', en: 'Next to the source file' },
  'project.outFolder': { ru: 'В другую папку', en: 'In another folder' },
  'project.outDir.placeholder': { ru: 'папка не выбрана', en: 'no folder chosen' },
  'project.browse': { ru: 'Обзор', en: 'Browse' },
  'project.outFile': { ru: 'Файл: {path}', en: 'File: {path}' },
  'project.outPickFirst': {
    ru: 'Выберите папку — файл получит имя по имени исходного.',
    en: 'Choose a folder — the file is named after the source.',
  },
  'project.clearCache': { ru: 'Сбросить кэш этого файла', en: 'Clear this file’s cache' },
  'project.hint.done': {
    ru: 'Уже озвучено. Повторный запуск возьмёт готовые стадии из кэша и пересчитает только изменённое.',
    en: 'Already dubbed. Running again reuses cached stages and recomputes only what changed.',
  },
  'project.hint.fresh': {
    ru: 'Нажмите «Дублировать» — пройдут все стадии, готовые возьмутся из кэша.',
    en: 'Press Dub — every stage runs, and finished ones come from the cache.',
  },

  // --- стадии
  'stage.s1': { ru: 'Аудио', en: 'Audio' },
  'stage.s2': { ru: 'Распознавание', en: 'Recognition' },
  'stage.s3': { ru: 'Перевод', en: 'Translation' },
  'stage.s4': { ru: 'Фонограмма', en: 'Background' },
  'stage.s5': { ru: 'Синтез', en: 'Synthesis' },
  'stage.s6': { ru: 'Подгонка', en: 'Fitting' },
  'stage.s7': { ru: 'Сведение', en: 'Mixing' },
  'stage.state.pending': { ru: 'ожидает', en: 'waiting' },
  'stage.state.running': { ru: 'выполняется…', en: 'running…' },
  'stage.state.done': { ru: 'готово', en: 'done' },
  'stage.state.cached': { ru: 'в кэше', en: 'cached' },
  'stage.state.skipped': { ru: 'пропущена', en: 'skipped' },
  'stage.state.never': { ru: 'не выполнялась', en: 'never run' },

  // --- состояние задачи
  'job.running': { ru: 'выполняется', en: 'running' },
  'job.done': { ru: 'готово', en: 'done' },
  'job.error': { ru: 'ошибка', en: 'error' },
  'job.cancelled': { ru: 'остановлено', en: 'cancelled' },
  'job.started': { ru: 'Обработка запущена', en: 'Processing started' },
  'job.stopping': {
    ru: 'Останавливаю: процессы прерваны, готовые стадии остаются в кэше',
    en: 'Stopping: processes aborted, finished stages stay in the cache',
  },
  'job.nothingToStop': { ru: 'нечего останавливать', en: 'nothing to stop' },
  'job.result': { ru: 'Готово: {path} — смотрите и правьте ниже.', en: 'Done: {path} — watch and fix it below.' },

  // --- вкладки
  'tab.segments': { ru: 'Реплики', en: 'Replicas' },
  'tab.subtitles': { ru: 'Субтитры', en: 'Subtitles' },
  'tab.compare': { ru: 'Сравнение моделей', en: 'Model comparison' },
  'tab.log': { ru: 'Журнал', en: 'Log' },

  // --- субтитры
  'subs.source': { ru: 'Оригинал', en: 'Original' },
  'subs.sourceWithLang': { ru: 'Оригинал ({name})', en: 'Original ({name})' },
  'subs.target': { ru: 'Перевод', en: 'Translation' },
  'subs.make': { ru: 'Сделать субтитры', en: 'Make subtitles' },
  'subs.save': { ru: 'Сохранить SRT', en: 'Save SRT' },
  'subs.rebuild': { ru: 'Пересобрать из реплик', en: 'Rebuild from replicas' },
  'subs.col.start': { ru: 'Начало', en: 'Start' },
  'subs.col.end': { ru: 'Конец', en: 'End' },
  'subs.col.duration': { ru: 'Длит.', en: 'Length' },
  'subs.col.text': { ru: 'Текст (не более двух строк)', en: 'Text (two lines at most)' },
  'subs.col.problems': { ru: 'Замечания', en: 'Warnings' },
  'subs.cps': { ru: '{value} зн/с', en: '{value} cps' },
  'subs.summary': { ru: '{count} титров', en: '{count} cues' },
  'subs.summary.problems': { ru: ', с замечаниями: {count}', en: ', with warnings: {count}' },
  'subs.summary.clean': { ru: ', замечаний нет', en: ', no warnings' },
  'subs.summary.dirty': { ru: ' · есть несохранённые правки', en: ' · unsaved edits' },
  'subs.notWritten': { ru: ' (ещё не записан)', en: ' (not written yet)' },
  'subs.none': {
    ru: 'Субтитров пока нет. Нажмите «Сделать субтитры» — программа распознает речь, переведёт её и запишет два файла SRT.',
    en: 'No subtitles yet. Press “Make subtitles” — speech is recognized, translated, and written to two SRT files.',
  },
  'subs.noneSource': { ru: 'Титров оригинала нет: речь ещё не распознана.', en: 'No original cues: speech has not been recognized yet.' },
  'subs.noneTarget': { ru: 'Титров перевода нет: реплики ещё не переведены.', en: 'No translated cues: replicas have not been translated yet.' },
  'subs.started': {
    ru: 'Делаю субтитры: распознавание, перевод и запись двух файлов SRT',
    en: 'Making subtitles: recognition, translation and two SRT files',
  },
  'subs.saved': { ru: 'Сохранено титров: {count} → {path}', en: 'Saved {count} cues → {path}' },
  'subs.rebuilt': { ru: 'Титры пересобраны из реплик', en: 'Cues rebuilt from replicas' },
  'subs.rebuildConfirm': {
    ru: 'Вернуть титры, рассчитанные из реплик? Ручные правки этого языка будут потеряны.',
    en: 'Restore cues computed from replicas? Manual edits for this track will be lost.',
  },
  'subs.switchConfirm': {
    ru: 'Правки текущего языка не сохранены. Переключиться и потерять их?',
    en: 'The current track has unsaved edits. Switch and lose them?',
  },
  'subs.badTime': { ru: 'Не понял время: ждал 01:23.400 или 83.4', en: 'Could not read the time: expected 01:23.400 or 83.4' },
  'subs.playHere': { ru: 'Перемотать сюда', en: 'Jump here' },
  'problem.too_fast': { ru: 'быстро читать', en: 'too fast to read' },
  'problem.too_short': { ru: 'слишком коротко', en: 'too short' },
  'problem.too_long': { ru: 'слишком долго', en: 'too long' },
  'problem.line_overflow': { ru: 'строка длиннее нормы', en: 'line too long' },
  'problem.too_many_lines': { ru: 'больше двух строк', en: 'more than two lines' },
  'problem.overlap': { ru: 'наезжает на следующий', en: 'overlaps the next cue' },

  // --- разметка страницы
  'library.noFolder': { ru: 'не выбрана', en: 'not chosen' },
  'library.recentFolders': { ru: 'Ранее обработанные файлы из других папок', en: 'Files processed earlier, from other folders' },
  'review.title': { ru: 'Просмотр и правка', en: 'Review and fix' },
  'review.lead': { ru: 'Смотрите готовый файл; всё, что не так, помечайте здесь — потом одна кнопка пересведёт файл.', en: 'Watch the finished file and mark anything wrong here — one button then re-mixes it.' },
  'review.levels': { ru: 'Громкости', en: 'Levels' },
  'review.levelsNote': { ru: 'Действуют только для этого видео.', en: 'They apply to this video only.' },
  'review.voiceLevel': { ru: 'Русская речь', en: 'Russian speech' },
  'review.duck': { ru: 'Приглушение оригинала под речью', en: 'Ducking under speech' },
  'review.apply': { ru: 'Внести правки и пересвести', en: 'Apply fixes and re-mix' },
  'review.discard': { ru: 'Отменить пометки', en: 'Discard marks' },
  'review.reset': { ru: 'Начать заново', en: 'Start over' },
  'segments.save': { ru: 'Сохранить правки', en: 'Save edits' },
  'segments.slot': { ru: 'Слот', en: 'Slot' },
  'segments.speaker': { ru: 'Спикер', en: 'Speaker' },
  'segments.fit': { ru: 'Укладка', en: 'Fit' },
  'segments.flags': { ru: 'Флаги', en: 'Flags' },
  'compare.lead': { ru: 'Одни и те же реплики проходят через несколько моделей. Рядом — укладка в слот, время и стоимость. Понравившийся вариант применяется одной кнопкой.', en: 'The same replicas go through several models. Fit, time and cost are shown side by side; one button applies the variant you like.' },
  'compare.limit': { ru: 'Реплик для пробы', en: 'Replicas to try' },
  'compare.models': { ru: 'Модели через запятую', en: 'Models, comma separated' },
  'compare.run': { ru: 'Сравнить', en: 'Compare' },
  'compare.search': { ru: 'поиск по каталогу моделей', en: 'search the model catalogue' },
  'compare.freeOnly': { ru: 'только бесплатные', en: 'free only' },
  'log.debug': { ru: 'подробные строки', en: 'verbose lines' },
  'log.clear': { ru: 'Очистить', en: 'Clear' },
  'settings.lead': { ru: 'Изменения применяются после сохранения. Значения проверяются, ошибка показывается у поля.', en: 'Changes take effect once saved. Values are validated, and errors appear next to the field.' },
  'settings.group.voice': { ru: 'Голос', en: 'Voice' },
  'settings.group.asr': { ru: 'Распознавание', en: 'Recognition' },
  'settings.group.audio': { ru: 'Звук', en: 'Audio' },
  'settings.group.fit': { ru: 'Подгонка', en: 'Fitting' },
  'settings.group.system': { ru: 'Система', en: 'System' },
  'settings.group.yaml': { ru: 'Файл YAML', en: 'YAML file' },
  'settings.where': { ru: 'Где переводить', en: 'Where to translate' },
  'settings.whereNote': { ru: 'Облачная модель качественнее и требует ключ. Локальный вариант работает без сети через Ollama.', en: 'The cloud model is better and needs a key. The local one works offline through Ollama.' },
  'settings.cloud': { ru: 'Облачная модель', en: 'Cloud model' },
  'settings.local': { ru: 'Локально (Ollama)', en: 'Local (Ollama)' },
  'settings.key': { ru: 'Ключ доступа', en: 'API key' },
  'settings.key.placeholder': { ru: 'вставьте ключ', en: 'paste the key' },
  'common.show': { ru: 'показать', en: 'show' },
  'settings.key.save': { ru: 'Сохранить ключ', en: 'Save key' },
  'common.check': { ru: 'Проверить', en: 'Check' },
  'common.delete': { ru: 'Удалить', en: 'Delete' },
  'settings.model': { ru: 'Модель', en: 'Model' },
  'settings.model.placeholder': { ru: 'начните вводить: claude, gpt, free…', en: 'start typing: claude, gpt, free…' },
  'settings.model.test': { ru: 'Проверить модель', en: 'Test model' },
  'settings.model.testHint': { ru: 'Перевести три пробные реплики этой моделью', en: 'Translate three sample replicas with this model' },
  'settings.model.refresh': { ru: 'обновить каталог', en: 'refresh catalogue' },
  'settings.model.refreshHint': { ru: 'Запросить каталог заново', en: 'Fetch the catalogue again' },
  'settings.ollamaModel': { ru: 'Локальная модель Ollama', en: 'Local Ollama model' },
  'settings.profanity': { ru: 'Ненормативная лексика', en: 'Profanity' },
  'settings.profanityNote': { ru: 'Как переводить брань в оригинале.', en: 'How to translate swearing from the original.' },
  'settings.profanity.soft': { ru: 'Смягчать', en: 'Soften' },
  'settings.profanity.hard': { ru: 'Запикивать', en: 'Bleep out' },
  'settings.profanity.keep': { ru: 'Оставлять как есть', en: 'Keep as is' },
  'settings.fineTuning': { ru: 'Тонкая настройка', en: 'Fine tuning' },
  'settings.batchSize': { ru: 'Реплик в одном запросе', en: 'Replicas per request' },
  'settings.batchSizeNote': { ru: '8–12 — рекомендуемый диапазон.', en: '8–12 is the recommended range.' },
  'settings.cps': { ru: 'Темп речи, символов в секунду', en: 'Speech rate, characters per second' },
  'settings.cpsNote': { ru: 'Ориентир для подбора длины перевода. Фактический темп показывается после синтеза.', en: 'A target for translation length. The actual rate is reported after synthesis.' },
  'settings.fitPass': { ru: 'Дожимать длину вторым запросом', en: 'Second pass for length' },
  'settings.fitPassNote': { ru: 'Реплики, не попавшие в слот, переписываются ещё раз.', en: 'Replicas that miss their slot are rewritten once more.' },
  'settings.defaultVoice': { ru: 'Голос по умолчанию', en: 'Default voice' },
  'settings.defaultVoiceNote': { ru: 'Русские голоса piper. Работают без сети.', en: 'Russian piper voices. They work offline.' },
  'settings.preview': { ru: 'Прослушать', en: 'Preview' },
  'settings.voiceMap': { ru: 'Голоса спикеров', en: 'Speaker voices' },
  'settings.asrTitle': { ru: 'Распознавание речи', en: 'Speech recognition' },
  'settings.whisperModel': { ru: 'Модель Whisper', en: 'Whisper model' },
  'settings.whisperModelNote': { ru: 'Крупнее — точнее и медленнее. Веса загружаются при первом использовании.', en: 'Bigger is more accurate and slower. Weights download on first use.' },
  'settings.whisper.tiny': { ru: 'tiny — 75 МБ, быстро, грубо', en: 'tiny — 75 MB, fast and rough' },
  'settings.whisper.base': { ru: 'base — 142 МБ', en: 'base — 142 MB' },
  'settings.whisper.small': { ru: 'small — 465 МБ, разумный баланс', en: 'small — 465 MB, a sensible balance' },
  'settings.whisper.medium': { ru: 'medium — 1.5 ГБ, точнее, в 3 раза медленнее', en: 'medium — 1.5 GB, more accurate, 3× slower' },
  'settings.whisper.large': { ru: 'large-v3 — 3.1 ГБ, лучшее качество, медленно', en: 'large-v3 — 3.1 GB, best quality, slow' },
  'settings.sourceLanguage': { ru: 'Язык оригинала', en: 'Source language' },
  'settings.sourceLanguageNote': { ru: 'На каком языке говорят в оригинале.', en: 'What language is spoken in the original.' },
  'settings.vad': { ru: 'Уточнять границы реплик по речи', en: 'Refine replica boundaries by speech' },
  'settings.vadNote': { ru: 'Подтягивает начало и конец к реальной речи. Отключать не стоит.', en: 'Pulls the start and end to the actual speech. Better left on.' },
  'settings.diarization': { ru: 'Разные голоса для персонажей', en: 'Separate voices per character' },
  'settings.hfToken': { ru: 'Токен Hugging Face', en: 'Hugging Face token' },
  'settings.hfToken.save': { ru: 'Сохранить токен', en: 'Save token' },
  'settings.separation': { ru: 'Убирать оригинальную речь из фонограммы', en: 'Remove the original speech from the soundtrack' },
  'settings.backgroundLevel': { ru: 'Громкость фона', en: 'Background level' },
  'settings.voiceLevel': { ru: 'Громкость дубляжа', en: 'Dub level' },
  'settings.loudnorm': { ru: 'Выравнивать громкость итога', en: 'Normalize the final loudness' },
  'settings.loudnormNote': { ru: 'Нормализация по стандарту вещания (EBU R128).', en: 'Normalization to the broadcast standard (EBU R128).' },
  'settings.keepOriginal': { ru: 'Оставлять оригинальную дорожку', en: 'Keep the original track' },
  'settings.keepOriginalNote': { ru: 'В итоговом файле будет две дорожки: русская и исходная — переключаются в плеере.', en: 'The result has two tracks, Russian and original, switchable in the player.' },
  'settings.fitTitle': { ru: 'Подгонка по времени', en: 'Time fitting' },
  'settings.alignment': { ru: 'Подгонять реплики под таймкоды', en: 'Fit replicas to the timings' },
  'settings.alignmentNote': { ru: 'Ускорение, сокращение и разведение наложений. Без этого реплики кладутся как есть.', en: 'Speeding up, shortening and separating overlaps. Without it replicas are placed as they are.' },
  'settings.maxTempo': { ru: 'Максимальное ускорение', en: 'Maximum speed-up' },
  'settings.maxRetranslate': { ru: 'Попыток сократить реплику', en: 'Shortening attempts' },
  'settings.maxRetranslateNote': { ru: 'Сколько раз просить модель укоротить текст, если он не влезает.', en: 'How many times to ask the model to shorten text that does not fit.' },
  'settings.maxShift': { ru: 'Предел сдвига реплики, мс', en: 'Replica shift limit, ms' },
  'settings.maxShiftNote': { ru: 'Насколько реплика может опоздать, чтобы не наехать на предыдущую.', en: 'How late a replica may start so it does not overlap the previous one.' },
  'settings.cacheDir': { ru: 'Служебный каталог', en: 'Working directory' },
  'settings.cacheDirNote': { ru: 'Кэш стадий, загруженные программы и модели.', en: 'Stage cache, downloaded programs and models.' },
  'settings.cacheFiles': { ru: 'Кэш обработанных файлов', en: 'Processed files cache' },
  'settings.cacheFilesNote': { ru: 'Программы и модели не удаляются — только промежуточные результаты.', en: 'Programs and models are kept — only intermediate results are removed.' },
  'settings.clearCache': { ru: 'Очистить кэш', en: 'Clear cache' },
  'settings.configFile': { ru: 'Файл настроек', en: 'Settings file' },
  'settings.yamlNote': { ru: 'Полный файл настроек для тех, кому так удобнее. Сохраняется той же кнопкой.', en: 'The whole settings file, for those who prefer it. Saved by the same button.' },
  'settings.unsaved': { ru: 'Есть несохранённые изменения', en: 'Unsaved changes' },
  'env.lead': { ru: 'Программы и модели загружаются в служебный каталог — без установки в систему и прав администратора.', en: 'Programs and models download into the working directory — no system installation, no administrator rights.' },
  'env.fetch': { ru: 'Догрузить недостающее', en: 'Download what is missing' },
  'env.recheck': { ru: 'Проверить заново', en: 'Check again' },
  'legal.title': { ru: 'Только для личного просмотра', en: 'Personal use only' },
  'browser.title': { ru: 'Выберите папку', en: 'Choose a folder' },
  'browser.choose': { ru: 'Выбрать эту папку', en: 'Choose this folder' },
  'other.lead': { ru: 'Путь к файлу на диске или ссылка на YouTube.', en: 'A path to a file on disk, or a YouTube link.' },
  'common.open': { ru: 'Открыть', en: 'Open' },

  'review.originalLevel': { ru: 'Оригинал', en: 'Original' },

  'readiness.enterKey': { ru: 'Ввести ключ', en: 'Enter the key' },
  'readiness.enterHfToken': { ru: 'Ввести токен Hugging Face', en: 'Enter the Hugging Face token' },
  'readiness.details': { ru: 'Подробнее', en: 'Details' },
  'progress.preparing': { ru: 'подготовка', en: 'preparing' },
  'progress.downloaded': { ru: 'загружено', en: 'downloaded' },
  'common.error': { ru: 'ошибка', en: 'error' },
  'env.allPresent': { ru: 'Всё уже загружено', en: 'Everything is already downloaded' },
  'env.fetching': { ru: 'Загружаю: {count}. Ход виден полосами вверху', en: 'Downloading {count}. Progress bars are at the top' },
  'env.checking': { ru: 'Проверяю компоненты…', en: 'Checking components…' },
  'env.toolsTitle': { ru: 'Расположение программ', en: 'Where the programs are' },
  'env.noTools': { ru: 'Ничего не загружено.', en: 'Nothing downloaded yet.' },
  'env.ready': { ru: 'готово', en: 'ready' },
  'browser.titleFolder': { ru: 'Выберите папку с видео', en: 'Choose a video folder' },
  'browser.titleFile': { ru: 'Выберите файл', en: 'Choose a file' },
  'browser.thisComputer': { ru: 'Этот компьютер', en: 'This computer' },
  'browser.hintFolder': { ru: 'Зайдите в нужную папку и нажмите «Выбрать эту папку»', en: 'Open the folder you need and press “Choose this folder”' },
  'browser.hintFile': { ru: 'Щёлкните по файлу', en: 'Click a file' },
  'browser.drives': { ru: 'к списку дисков', en: 'back to drives' },
  'browser.up': { ru: 'наверх', en: 'up' },
  'browser.empty': { ru: 'здесь нет ни папок, ни медиафайлов', en: 'no folders and no media files here' },
  'library.folderChosen': { ru: 'Папка выбрана', en: 'Folder chosen' },
  'library.noFolderHint': { ru: 'Папка не выбрана. Нажмите «Выбрать папку» — в списке появятся её видеофайлы.', en: 'No folder chosen. Press “Choose folder” and its video files appear in the list.' },
  'library.noMedia': { ru: 'В этой папке нет видео- и аудиофайлов.', en: 'No video or audio files in this folder.' },
  'library.dubbedAt': { ru: 'озвучено {date}', en: 'dubbed {date}' },

  'job.stopped': { ru: 'Остановлено: процессы прерваны, готовые стадии остались в кэше', en: 'Stopped: processes aborted, finished stages stayed in the cache' },
  'project.cacheCleared': { ru: 'Кэш файла сброшен — следующий запуск пройдёт все стадии заново', en: 'The file’s cache is cleared — the next run goes through every stage again' },
  'project.stagesDone': { ru: 'готово стадий: {count}', en: 'stages done: {count}' },
  'segments.empty': { ru: 'Реплики появятся после распознавания — нажмите «Дублировать».', en: 'Replicas appear after recognition — press Dub.' },
  'segments.synth': { ru: 'синтез {value} с', en: 'synthesis {value} s' },
  'segments.original': { ru: 'ориг.', en: 'orig.' },
  'segments.tts': { ru: 'синтез', en: 'synthesis' },
  'segments.noAudio': { ru: 'Оригинальное аудио появится после первой стадии', en: 'The original audio appears after the first stage' },
  'segments.count': { ru: '{count} реплик', en: '{count} replicas' },
  'segments.nothingToSave': { ru: 'Нечего сохранять', en: 'Nothing to save' },
  'segments.saved': { ru: 'Сохранено реплик: {count}. Чтобы переозвучить, запустите со стадии «Синтез» в «Дополнительно».', en: 'Saved {count} replicas. To re-voice them, start from the Synthesis stage under Advanced.' },
  'review.byRecordMale': { ru: ' · по записи мужчина, {hz} Гц', en: ' · male by the recording, {hz} Hz' },
  'review.byRecordFemale': { ru: ' · по записи женщина, {hz} Гц', en: ' · female by the recording, {hz} Hz' },
  'review.byRecordUnknown': { ru: ' · пол по записи не определён', en: ' · gender undetermined from the recording' },
  'review.waiting': { ru: 'Запустите видео — здесь появится реплика, которая звучит сейчас, и кнопки правки.', en: 'Start the video — the replica playing right now appears here, with the controls to fix it.' },
  'review.replica': { ru: 'Реплика {id}', en: 'Replica {id}' },
  'review.prev': { ru: 'Предыдущая реплика', en: 'Previous replica' },
  'review.replay': { ru: 'Прослушать ещё раз', en: 'Play again' },
  'review.next': { ru: 'Следующая реплика', en: 'Next replica' },
  'review.prevShort': { ru: '‹ пред.', en: '‹ prev' },
  'review.replayShort': { ru: 'ещё раз', en: 'again' },
  'review.nextShort': { ru: 'след. ›', en: 'next ›' },
  'review.textTitle': { ru: 'Перевод этой реплики', en: 'Translation of this replica' },
  'review.speakerLabel': { ru: 'Спикер', en: 'Speaker' },
  'review.newSpeaker': { ru: 'новый спикер…', en: 'new speaker…' },
  'review.voiceIs': { ru: 'голос: {name} ({gender})', en: 'voice: {name} ({gender})' },
  'review.makeFemale': { ru: 'Сделать голос женским', en: 'Make this voice female' },
  'review.makeMale': { ru: 'Сделать голос мужским', en: 'Make this voice male' },
  'review.voiceOfSpeaker': { ru: 'Голос спикера', en: 'Speaker’s voice' },
  'review.markSpeaker': { ru: 'реплика {id}: {from} → {to}', en: 'replica {id}: {from} → {to}' },
  'review.markText': { ru: 'реплика {id}: перевод изменён', en: 'replica {id}: translation changed' },
  'review.markVoice': { ru: '{speaker}: голос {from} → {to}', en: '{speaker}: voice {from} → {to}' },
  'review.marks': { ru: 'Пометки ({count}):', en: 'Marks ({count}):' },
  'review.noMarks': { ru: 'Пометок пока нет.', en: 'No marks yet.' },
  'review.nothingToApply': { ru: 'Изменений, требующих пересведения, нет', en: 'Nothing that needs a re-mix' },
  'review.applied': { ru: 'Правки сохранены: переозвучу {count} реплик и пересведу файл', en: 'Fixes saved: {count} replicas will be re-voiced and the file re-mixed' },
  'review.appliedMix': { ru: 'Правки сохранены: пересвожу файл с новыми громкостями', en: 'Fixes saved: re-mixing the file with the new levels' },
  'review.resetConfirm': { ru: 'Удалить всё, что сделано для этого видео (распознавание, перевод, озвучка), и начать с нуля? Готовый файл останется на диске.', en: 'Delete everything done for this video (recognition, translation, voicing) and start over? The finished file stays on disk.' },
  'review.resetDone': { ru: 'Всё сброшено. Нажмите «Дублировать», чтобы начать заново', en: 'Everything is cleared. Press Dub to start over' },
  'common.male': { ru: 'м', en: 'm' },
  'common.female': { ru: 'ж', en: 'f' },
  'common.seconds': { ru: '{value} с', en: '{value} s' },

  'compare.unavailable': { ru: 'Каталог моделей недоступен: {error}', en: 'The model catalogue is unavailable: {error}' },
  'compare.needModel': { ru: 'Укажите хотя бы одну модель', en: 'Name at least one model' },
  'compare.needSegments': { ru: 'Сначала нужно распознать речь', en: 'Recognize the speech first' },
  'compare.running': { ru: 'Идёт сравнение — это занимает десятки секунд…', en: 'Comparing — this takes tens of seconds…' },
  'compare.done': { ru: 'Сравнение готово', en: 'Comparison is ready' },
  'compare.col.model': { ru: 'Модель', en: 'Model' },
  'compare.col.withinTolerance': { ru: 'В допуске', en: 'Within tolerance' },
  'compare.col.time': { ru: 'Время', en: 'Time' },
  'compare.col.tokens': { ru: 'Токены', en: 'Tokens' },
  'compare.col.cost': { ru: 'Стоимость', en: 'Cost' },
  'compare.slot': { ru: '[{id}] слот {slot} с — {text}', en: '[{id}] slot {slot} s — {text}' },
  'compare.applied': { ru: 'Перевод {model} применён. Переозвучьте со стадии «Синтез».', en: 'The {model} translation is applied. Re-voice from the Synthesis stage.' },
  'settings.dirtyCount': { ru: 'Изменено настроек: {count}', en: 'Changed settings: {count}' },
  'settings.yamlDirty': { ru: 'Файл YAML изменён', en: 'The YAML file has changed' },
  'settings.asDefault': { ru: 'как по умолчанию', en: 'same as default' },
  'settings.free': { ru: 'бесплатно', en: 'free' },
  'settings.catalogEmpty': { ru: 'Каталог не загружен: нужен ключ и сеть. Имя модели можно вписать вручную.', en: 'The catalogue is not loaded: a key and network are needed. You can type a model name by hand.' },
  'settings.catalogNoMatch': { ru: 'Ничего не найдено. Значение можно оставить как есть.', en: 'Nothing found. You can leave the value as it is.' },
  'settings.catalogMore': { ru: '…и ещё {count}, уточните запрос', en: '…and {count} more, narrow the query' },
  'settings.catalogCount': { ru: 'в каталоге моделей: {count}', en: 'models in the catalogue: {count}' },
  'settings.catalogMatched': { ru: ', подходит: {count}', en: ', matching: {count}' },
  'settings.catalogMissing': { ru: 'каталог не загружен: нужен ключ и сеть', en: 'catalogue not loaded: a key and network are needed' },
  'settings.catalogFailed': { ru: 'каталог недоступен: {error}', en: 'catalogue unavailable: {error}' },
  'settings.catalogRefreshed': { ru: 'Каталог обновлён: {count} моделей', en: 'Catalogue refreshed: {count} models' },
  'settings.model.works': { ru: 'Модель переводит: {seconds} с, {cost} за 3 реплики', en: 'The model translates: {seconds} s, {cost} for 3 replicas' },
  'settings.model.fails': { ru: 'Не годится: {reason}', en: 'Not suitable: {reason}' },
  'settings.model.noAnswer': { ru: 'ответ не получен', en: 'no answer' },
  'settings.model.noTranslation': { ru: '— нет перевода —', en: '— no translation —' },
  'settings.model.longNote': { ru: 'Часть реплик длиннее слота — на стадии подгонки их сократит корректирующий проход.', en: 'Some replicas are longer than their slot — the fitting stage will shorten them.' },
  'settings.model.pickFirst': { ru: 'Сначала выберите модель', en: 'Choose a model first' },
  'settings.model.ok': { ru: 'Модель {model} переводит', en: 'The {model} model translates' },
  'settings.model.bad': { ru: 'Модель {model}: {reason}', en: 'Model {model}: {reason}' },
  'settings.willBeCreated': { ru: ' (будет создан при сохранении)', en: ' (will be created on save)' },
  'settings.savedAs': { ru: 'сохранён: {masked}', en: 'saved: {masked}' },
  'settings.notSet': { ru: 'не задан', en: 'not set' },
  'common.hide': { ru: 'скрыть', en: 'hide' },
  'settings.pasteToken': { ru: 'Вставьте токен', en: 'Paste the token' },
  'settings.tokenSaved': { ru: 'Токен сохранён. Веса модели загрузятся по кнопке «Догрузить недостающее»', en: 'Token saved. The model weights download from “Download what is missing”' },
  'settings.tokenRemoved': { ru: 'Токен удалён', en: 'Token removed' },
  'settings.pasteKey': { ru: 'Вставьте ключ', en: 'Paste the key' },
  'settings.keySaved': { ru: 'Ключ сохранён и применён', en: 'Key saved and applied' },
  'settings.keyWorks': { ru: 'Ключ работает: шлюз ответил', en: 'The key works: the gateway answered' },
  'settings.keyRejected': { ru: 'Ключ не принят: {reason}', en: 'Key rejected: {reason}' },
  'settings.keyRemoved': { ru: 'Ключ удалён', en: 'Key removed' },
  'settings.cleared': { ru: 'Очищено: {count}', en: 'Cleared: {count}' },
  'settings.saved': { ru: 'Настройки сохранены', en: 'Settings saved' },
  'env.state.ok': { ru: 'готово', en: 'ready' },
  'env.state.warn': { ru: 'внимание', en: 'attention' },
  'env.state.blocked': { ru: 'нет', en: 'missing' },
  'profile.local': { ru: 'перевод: локально', en: 'translation: local' },
  'profile.cloud': { ru: 'перевод: облачная модель', en: 'translation: cloud model' },
  'job.finishedOk': { ru: 'Готово — файл озвучен', en: 'Done — the file is voiced' },
  'job.finishedOther': { ru: 'Обработка: {status}', en: 'Processing: {status}' },

  'unit.kb': { ru: 'КБ', en: 'KB' },
  'unit.mb': { ru: 'МБ', en: 'MB' },
  'unit.gb': { ru: 'ГБ', en: 'GB' },
  'unit.db': { ru: 'дБ', en: 'dB' },

  'settings.asrBackend': { ru: 'Чем считать распознавание', en: 'What computes recognition' },
  'settings.asrBackendNote': {
    ru: 'Сборка whisper.cpp. Автоматически выбирается официальная под ваше железо. Vulkan работает на видеокартах AMD и Intel и вдвое быстрее, но собран не проектом whisper.cpp.',
    en: 'The whisper.cpp build. Automatic picks an official one for your hardware. Vulkan works on AMD and Intel GPUs and is twice as fast, but it is not built by the whisper.cpp project.',
  },
  'settings.backend.auto': { ru: 'Автоматически', en: 'Automatic' },
  'settings.backend.blas': { ru: 'Процессор (BLAS)', en: 'CPU (BLAS)' },
  'settings.backend.cpu': { ru: 'Процессор без BLAS', en: 'CPU without BLAS' },
  'settings.backend.cuda': { ru: 'Видеокарта NVIDIA (CUDA)', en: 'NVIDIA GPU (CUDA)' },
  'settings.backend.vulkan': { ru: 'Видеокарта через Vulkan (AMD, Intel)', en: 'GPU through Vulkan (AMD, Intel)' },

  'settings.diarizationDevice': { ru: 'Где считать голоса', en: 'Where to work out the voices' },
  'settings.diarizationDeviceNote': {
    ru: 'На видеокарте вчетверо быстрее, если установлен onnxruntime-directml. Результат тот же.',
    en: 'Four times faster on the GPU when onnxruntime-directml is installed. The result is the same.',
  },
  'settings.separationApply': { ru: 'Что делать с оригиналом', en: 'What to do with the original' },
  'settings.separationApplyNote': {
    ru: 'Убирать исходный голос только под русской речью — тогда музыка не приседает, а песня без дубляжа сохраняет вокал. Либо заменить оригинал фоном на весь фильм: голос уйдёт везде, но песни лишатся вокала.',
    en: 'Remove the original voice only under the Russian speech — the music then does not dip, and a song left undubbed keeps its vocals. Or replace the original with the background for the whole film: the voice goes everywhere, and songs lose their vocals.',
  },
  'settings.apply.underSpeech': { ru: 'Только под нашей речью', en: 'Only under our speech' },
  'settings.apply.everywhere': { ru: 'Во всём фильме', en: 'Across the whole film' },

  'settings.voiceResidual': { ru: 'Подложка исходного голоса', en: 'Trace of the original voice' },
  'settings.voiceResidualNote': {
    ru: 'Сколько исходного голоса оставить под русской речью. Полная тишина звучит стерильно: вместе с голосом уходят дыхание и отзвук комнаты.',
    en: 'How much of the original voice to leave under the Russian speech. Removing all of it sounds sterile: the breath and the room go with the voice.',
  },
  'settings.residual.loud': { ru: 'Заметная (−6 дБ)', en: 'Noticeable (−6 dB)' },
  'settings.residual.normal': { ru: 'Обычная (−12 дБ)', en: 'Normal (−12 dB)' },
  'settings.residual.quiet': { ru: 'Тихая (−18 дБ)', en: 'Quiet (−18 dB)' },
  'settings.residual.none': { ru: 'Без подложки', en: 'None' },

  'settings.separationDevice': { ru: 'Где считать отделение', en: 'Where to separate the voice' },
  'settings.separationDeviceNote': {
    ru: 'На видеокарте впятеро быстрее: минута звука за три секунды вместо семнадцати.',
    en: 'Five times faster on the GPU: a minute of audio in three seconds instead of seventeen.',
  },
  'settings.device.auto': { ru: 'Автоматически', en: 'Automatic' },
  'settings.device.gpu': { ru: 'Видеокарта', en: 'GPU' },
  'settings.device.igpu': { ru: 'Встроенная видеокарта', en: 'Integrated GPU' },
  'settings.device.dgpu': { ru: 'Отдельная видеокарта', en: 'Discrete GPU' },
  'settings.device.cpu': { ru: 'Процессор', en: 'CPU' },

  'settings.whisper.turbo': { ru: 'large-v3-turbo — 1.5 ГБ, качество large, быстрее втрое', en: 'large-v3-turbo — 1.5 GB, large quality, three times faster' },

  // --- общее
  'common.cancel': { ru: 'Отмена', en: 'Cancel' },
  'common.close': { ru: 'Закрыть', en: 'Close' },
  'common.ok': { ru: 'Понятно', en: 'Got it' },
  'common.save': { ru: 'Сохранить', en: 'Save' },
  'common.reload': { ru: 'Перечитать', en: 'Reload' },
};

const SUPPORTED = ['ru', 'en'];
const STORAGE_KEY = 'dubpipe-ui-language';

function detectLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved)) return saved;
  } catch {
    // Приватный режим браузера: выбор просто не сохранится.
  }
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED.includes(browser) ? browser : 'en';
}

let current = detectLanguage();

function language() {
  return current;
}

/** Перевод по ключу с подстановкой {переменных}. */
function t(key, values) {
  const entry = DICTIONARY[key];
  let text = entry ? entry[current] ?? entry.ru ?? key : key;
  if (values) {
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/**
 * Проставляет переводы в разметке. Элементы помечаются атрибутами:
 *   data-i18n            — текст элемента
 *   data-i18n-html       — разметка внутри (когда есть <code> и ссылки)
 *   data-i18n-placeholder, data-i18n-title — одноимённые атрибуты
 */
function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((element) => {
    element.innerHTML = t(element.dataset.i18nHtml);
  });
  for (const attribute of ['placeholder', 'title']) {
    root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
      element.setAttribute(attribute, t(element.dataset[`i18n${attribute[0].toUpperCase()}${attribute.slice(1)}`]));
    });
  }
  document.documentElement.lang = current;
}

/** Меняет язык интерфейса и перерисовывает страницу. */
function setLanguage(code) {
  if (!SUPPORTED.includes(code) || code === current) return false;
  current = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Не сохранилось — язык всё равно применится до конца сеанса.
  }
  applyTranslations();
  return true;
}

const LANGUAGES = SUPPORTED;

// Страница подключает скрипты обычными тегами, а не модулями, поэтому доступ —
// через глобальные имена: `t('nav.library')` в остальном коде интерфейса.
window.t = t;
window.i18n = { t, language, setLanguage, applyTranslations, LANGUAGES };
