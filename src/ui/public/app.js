/**
 * Веб-приложение DubPipe (ТЗ §16).
 *
 * Логики конвейера здесь нет — только вызовы локального API, поэтому оболочку
 * рабочего стола можно заменить, не трогая интерфейс (ТЗ §16.2).
 * Ни сборки, ни внешних библиотек: страница должна открываться офлайн.
 *
 * Устройство: один объект — видеофайл как проект. Главный экран — папка
 * с видео, страница проекта — запуск, ход стадий, реплики, сравнение моделей.
 */

const TOKEN = new URLSearchParams(location.search).get('token') ?? '';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  legalAccepted: false,
  workingDir: null,
  projects: [],
  stages: [],
  config: null,
  project: null,          // путь или ссылка открытого проекта
  segments: [],
  originalAudio: null,
  // Мерка длины реплики; настоящая приходит вместе с репликами, эта нужна
  // лишь до первой загрузки.
  fit: { charsPerSecond: 17.8, overheadSeconds: 0.51, tolerance: 0.15, toleranceFloorSeconds: 0.25, room: {} },
  job: null,
  progress: new Map(),
  dirty: {},              // изменённые настройки: 'translate.model' → значение
};

// --- общие утилиты ---------------------------------------------------------

async function api(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  // Язык интерфейса уходит с каждым запросом: часть текста (панель готовности,
  // причины отказов) рождается на сервере и должна прийти на нужном языке.
  const response = await fetch(`${path}${separator}token=${TOKEN}&lang=${window.i18n.language()}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-DubPipe-Token': TOKEN, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });

const mediaUrl = (filePath) => `/api/media?path=${encodeURIComponent(filePath)}&token=${TOKEN}`;
const icon = (name, cls = 'ico') => `<svg class="${cls}"><use href="#i-${name}" /></svg>`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const escapeAttr = (value) => escapeHtml(value).replace(/\n/g, ' ');

function formatBytes(bytes) {
  if (!bytes) return `0 ${t('unit.kb')}`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} ${t('unit.kb')}`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} ${t('unit.mb')}`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ${t('unit.gb')}`;
}

const baseName = (input) => (/^https?:\/\//i.test(input) ? input : input.split(/[\\/]/).pop());

function toast(message, kind = 'info', timeout = 5000) {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  $('#toasts').appendChild(element);
  setTimeout(() => element.remove(), timeout);
}

function showError(error) {
  console.error(error);
  toast(error.message ?? String(error), 'error', 9000);
}

async function withBusy(button, task) {
  button.classList.add('busy');
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.classList.remove('busy');
    button.disabled = false;
  }
}

function getPath(object, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object);
}

// --- навигация -------------------------------------------------------------

function showView(name) {
  $$('#nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name));
  if (name === 'library') $$('#nav button[data-view="library"]')[0].classList.add('active');
  if (name === 'project') $$('#nav button[data-view="library"]')[0].classList.add('active');
  if (name === 'environment') loadEnvironment().catch(showError);
  if (name === 'settings') loadSettings().catch(showError);
  window.scrollTo(0, 0);
}

$$('#nav button').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('#backToLibrary').addEventListener('click', () => showView('library'));

function showSubtab(name) {
  $$('#subtabs button').forEach((button) => button.classList.toggle('active', button.dataset.sub === name));
  $$('.subview').forEach((view) => view.classList.toggle('active', view.dataset.subview === name));
  if (name === 'subtitles') loadSubtitles().catch(showError);
}

$$('#subtabs button').forEach((button) => button.addEventListener('click', () => showSubtab(button.dataset.sub)));

// --- готовность ------------------------------------------------------------

function renderReadiness(data) {
  const box = $('#readiness');
  const problems = data.items.filter((item) => item.state !== 'ok');
  $('#envBadge').innerHTML = data.blocked > 0 ? '<span class="pill bad">!</span>' : data.warnings > 0 ? '<span class="pill warn">!</span>' : '';

  // Когда всё в порядке, ничего не показываем: человек пришёл озвучивать видео,
  // а не читать отчёт о состоянии компонентов.
  if (problems.length === 0) {
    box.hidden = true;
    return;
  }

  const fixable = problems.some((item) => item.canFix);
  box.hidden = false;
  box.innerHTML = `
    <div class="readiness-box ${data.blocked > 0 ? 'blocked' : ''}">
      <div class="head">${icon('warn')} ${escapeHtml(data.summary)}</div>
      <ul>
        ${problems
          .map((item) => `<li><b>${escapeHtml(item.title)}</b> — ${escapeHtml(item.detail)}${item.blocks ? `. ${escapeHtml(item.blocks)}` : ''}${item.hint ? ` <span class="meta">${escapeHtml(item.hint)}</span>` : ''}</li>`)
          .join('')}
      </ul>
      <div class="row">
        ${fixable ? `<button id="readinessFix" class="primary small">${icon('down')} ${t('env.fetch')}</button>` : ''}
        ${problems.some((item) => item.id === 'apikey') ? `<button id="readinessKey" class="small">${t('readiness.enterKey')}</button>` : ''}
        ${problems.some((item) => item.needsToken) ? `<button id="readinessHfToken" class="small">${t('readiness.enterHfToken')}</button>` : ''}
        <button id="readinessEnv" class="ghost small">${t('readiness.details')}</button>
      </div>
    </div>`;

  $('#readinessFix')?.addEventListener('click', (event) => startProvisioning(event.currentTarget));
  $('#readinessKey')?.addEventListener('click', () => {
    showView('settings');
    showSettingsGroup('translate');
  });
  $('#readinessHfToken')?.addEventListener('click', () => {
    showView('settings');
    showSettingsGroup('asr');
    $('#hfTokenInput').focus();
  });
  $('#readinessEnv')?.addEventListener('click', () => showView('environment'));
}

const loadReadiness = () => api('/api/readiness').then(renderReadiness);

// --- прогресс --------------------------------------------------------------

function renderProgress() {
  const list = $('#progressList');
  const all = [...state.progress.values()];
  const downloading = new Set(all.filter((item) => item.kind === 'download').map((item) => item.label));
  const items = all.filter((item) => item.kind !== 'provision' || !downloading.has(item.label));

  list.innerHTML = items
    .map((item) => {
      const known = item.percent !== null && item.percent !== undefined;
      const amount = item.totalBytes
        ? `${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}`
        : known ? `${item.percent}%` : `${item.detail ?? t('progress.preparing')}…`;
      return `<div class="progress-item">
        <div class="line"><strong>${escapeHtml(item.label)}</strong><span class="amount">${amount}</span></div>
        <div class="bar ${known ? '' : 'indeterminate'}"><i style="width:${known ? item.percent : 35}%"></i></div>
      </div>`;
    })
    .join('');
}

function applyProgress(event) {
  if (event.status === 'running') state.progress.set(event.id, event);
  else state.progress.delete(event.id);
  if (event.status === 'error') toast(`${event.label}: ${event.detail ?? t('common.error')}`, 'error', 9000);
  if (event.status === 'done' && event.kind === 'download') toast(`${event.label} — ${t('progress.downloaded')}`, 'ok', 3500);
  renderProgress();
}

async function startProvisioning(button) {
  await withBusy(button, async () => {
    const result = await post('/api/environment/fetch');
    if (!result.started) {
      toast(result.note ?? t('env.allPresent'), 'ok');
      await loadReadiness();
      return;
    }
    const count = (result.tools?.length ?? 0) + (result.weights?.length ?? 0);
    toast(t('env.fetching', { count }), 'info', 6000);
  });
}

// --- обозреватель файлов ---------------------------------------------------

const native = window.dubpipeNative;
const browserState = { dir: null, mode: 'folder', resolve: null };

async function openBrowser(mode, startDir) {
  browserState.mode = mode;
  $('#browserTitle').textContent = t(mode === 'folder' ? 'browser.titleFolder' : 'browser.titleFile');
  $('#browserChoose').hidden = mode !== 'folder';
  $('#browser').hidden = false;
  await browseTo(startDir ?? state.workingDir ?? null);
  return new Promise((resolve) => { browserState.resolve = resolve; });
}

function closeBrowser(result) {
  $('#browser').hidden = true;
  const resolve = browserState.resolve;
  browserState.resolve = null;
  if (resolve) resolve(result ?? null);
}

async function browseTo(dir) {
  let data;
  try {
    data = await api(`/api/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
  } catch (error) {
    $('#browserList').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    return;
  }
  browserState.dir = data.dir;
  $('#browserPath').textContent = data.dir ?? t('browser.thisComputer');
  $('#browserChoose').disabled = !data.dir;
  $('#browserHint').textContent = t(browserState.mode === 'folder' ? 'browser.hintFolder' : 'browser.hintFile');

  const rows = [];
  if (data.parent !== null) rows.push(`<div class="browser-item" data-dir="${escapeAttr(data.parent)}">${icon('up')}<span>${t('browser.up')}</span></div>`);
  else if (data.dir) rows.push(`<div class="browser-item" data-dir="">${icon('up')}<span>${t('browser.drives')}</span></div>`);
  for (const entry of data.entries) {
    const attribute = entry.isDir ? `data-dir="${escapeAttr(entry.path)}"` : `data-file="${escapeAttr(entry.path)}"`;
    rows.push(`<div class="browser-item" ${attribute}>${icon(entry.isDir ? 'folder' : 'video')}<span>${escapeHtml(entry.name)}</span><span class="size">${entry.isDir ? '' : formatBytes(entry.size)}</span></div>`);
  }
  if (data.entries.length === 0 && data.dir) rows.push(`<div class="browser-item"><span class="meta">${t('browser.empty')}</span></div>`);

  const list = $('#browserList');
  list.innerHTML = rows.join('');
  list.scrollTop = 0;
  list.querySelectorAll('[data-dir]').forEach((item) => item.addEventListener('click', () => browseTo(item.dataset.dir || null)));
  list.querySelectorAll('[data-file]').forEach((item) => item.addEventListener('click', () => browserState.mode === 'file' && closeBrowser(item.dataset.file)));
}

$('#browserClose').addEventListener('click', () => closeBrowser(null));
$('#browserChoose').addEventListener('click', () => closeBrowser(browserState.dir));

/** В окне приложения путь даёт системный диалог, в браузере — свой обозреватель. */
const pickFolderPath = () => (native?.available ? native.pickFolder(state.workingDir ?? undefined) : openBrowser('folder'));
const pickFilePath = () => (native?.available ? native.pickFile(state.workingDir ?? undefined) : openBrowser('file'));

async function pickFolder() {
  const chosen = await pickFolderPath();
  if (!chosen) return;
  await put('/api/workdir', { dir: chosen });
  state.workingDir = chosen;
  await loadLibrary();
  toast(t('library.folderChosen'), 'ok', 3000);
}
window.dubpipePickFolder = pickFolder;

$('#pickFolder').addEventListener('click', (event) => withBusy(event.currentTarget, pickFolder).catch(showError));
$('#refreshLibrary').addEventListener('click', (event) => withBusy(event.currentTarget, loadLibrary).catch(showError));

// --- другой файл или ссылка ------------------------------------------------

$('#openOther').addEventListener('click', () => { $('#otherDialog').hidden = false; $('#otherInput').focus(); });
$('#otherClose').addEventListener('click', () => { $('#otherDialog').hidden = true; });
$('#otherPick').addEventListener('click', async () => {
  const chosen = await pickFilePath().catch(showError);
  if (chosen) $('#otherInput').value = chosen;
});
$('#otherOpen').addEventListener('click', () => {
  const value = $('#otherInput').value.trim();
  if (!value) return;
  $('#otherDialog').hidden = true;
  openProject(value);
});

// --- библиотека ------------------------------------------------------------

function statusPill(stages) {
  if (stages.includes('s7')) return `<span class="pill ok">${t('library.state.dubbed')}</span>`;
  if (stages.length > 0) return `<span class="pill accent">${t('library.state.partial', { stages: stages.join(', ') })}</span>`;
  return `<span class="pill">${t('library.state.fresh')}</span>`;
}

async function loadLibrary() {
  const list = $('#libraryList');
  const data = await api('/api/library');
  state.workingDir = data.workingDir;
  $('#workdirPath').textContent = data.workingDir ?? t('library.noFolder');

  if (!data.workingDir) {
    list.innerHTML = `<div class="notice">${t('library.noFolderHint')}</div>`;
    return;
  }
  if (data.files.length === 0) {
    list.innerHTML = `<div class="notice warn">${t('library.noMedia')}</div>`;
    return;
  }

  list.innerHTML = data.files
    .map((file) => `
      <div class="card row-card">
        <div class="grow">
          <div class="name">${escapeHtml(file.name)}</div>
          <div class="meta">${formatBytes(file.size)}${file.processedAt ? ` · ${t('library.dubbedAt', { date: new Date(file.processedAt).toLocaleString() })}` : ''}</div>
        </div>
        ${statusPill(file.stages)}
        <button data-dub="${escapeAttr(file.path)}" class="primary small">${icon('play')} ${t('library.dub')}</button>
        <button data-subs="${escapeAttr(file.path)}" class="small" title="${escapeAttr(t('library.subtitlesHint'))}">${t('library.subtitles')}</button>
        <button data-open="${escapeAttr(file.path)}" class="small">${t('common.open')}</button>
      </div>`)
    .join('');

  list.querySelectorAll('[data-dub]').forEach((button) => button.addEventListener('click', () => openProject(button.dataset.dub, { start: true })));
  list.querySelectorAll('[data-subs]').forEach((button) => button.addEventListener('click', () => openProject(button.dataset.subs, { subtitles: true })));
  list.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => openProject(button.dataset.open)));
}

function renderProjects() {
  const list = $('#projectList');
  const block = $('#historyBlock');
  const others = state.projects.filter((project) => !state.workingDir || !project.input.replace(/\//g, '\\').startsWith(state.workingDir.replace(/\//g, '\\')));
  block.hidden = others.length === 0;
  list.innerHTML = others
    .map((project) => `
      <div class="card row-card">
        <div class="grow">
          <div class="name">${escapeHtml(baseName(project.input))}</div>
          <div class="meta mono">${escapeHtml(project.input)}</div>
        </div>
        ${statusPill(project.stages)}
        <button data-open="${escapeAttr(project.input)}" class="small">${t('common.open')}</button>
      </div>`)
    .join('');
  list.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => openProject(button.dataset.open)));
}

// --- проект ----------------------------------------------------------------

async function openProject(input, options = {}) {
  state.project = input;
  $('#projectName').textContent = baseName(input);
  $('#projectPath').textContent = input === baseName(input) ? '' : input;
  state.outDir = null;
  state.defaultOutputDir = null;
  $('#outDir').value = '';
  $$('input[name="outMode"]').forEach((radio) => { radio.checked = radio.value === 'beside'; });
  $('#outFolderRow').hidden = true;
  renderOutPlace();
  $('#modelOverride').value = '';
  $('#advanced').hidden = true;
  showView('project');
  renderJob();
  await loadSegments().catch(() => {});
  if (options.subtitles) {
    showSubtab('subtitles');
    await loadSubtitles().catch(() => {});
    startSubtitles().catch(showError);
  }
  if (options.start) startJob().catch(showError);
}

function fillStageSelects() {
  const options = state.stages.map((stage) => `<option value="${stage.id}">${stage.id} — ${stage.title}</option>`).join('');
  $('#fromStage').innerHTML = options;
  $('#toStage').innerHTML = options;
  $('#toStage').value = 's7';
}

$('#toggleAdvanced').addEventListener('click', () => { $('#advanced').hidden = !$('#advanced').hidden; });

async function startJob() {
  if (!state.project) return;
  // Новый прогон — новые сообщения: закрытые в прошлый раз не должны молчать.
  dismissedNotices.clear();
  const advanced = !$('#advanced').hidden;
  state.job = await post('/api/jobs', {
    input: state.project,
    fromStage: advanced ? $('#fromStage').value : undefined,
    toStage: advanced ? $('#toStage').value : undefined,
    model: advanced ? $('#modelOverride').value.trim() || undefined : undefined,
    // Папка итога — не «на этот раз»: выбранная, она действует независимо
    // от того, раскрыта ли панель «Дополнительно».
    outDir: outMode() === 'folder' && state.outDir ? state.outDir : undefined,
  });
  renderJob();
  toast(t('job.started'), 'ok', 3000);
}

$('#startJob').addEventListener('click', () => startJob().catch(showError));
$('#cancelJob').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const result = await post('/api/jobs/cancel');
    toast(
      result.ok ? t('job.stopped') : result.note,
      result.ok ? 'warn' : 'ok',
      5000,
    );
  }).catch(showError),
);
$('#clearProjectCache').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    await post('/api/cache/clear', { input: state.project });
    toast(t('project.cacheCleared'), 'ok');
    await loadSegments().catch(() => {});
  }).catch(showError),
);

const STAGE_SHORT = {
  s1: 'stage.s1', s2: 'stage.s2', s3: 'stage.s3', s4: 'stage.s4',
  s5: 'stage.s5', s6: 'stage.s6', s7: 'stage.s7',
};

function renderJob() {
  const job = state.job;
  const mine = job && state.project && job.input === state.project;
  const chip = $('#jobChip');

  // Индикатор в боковой панели: видно с любого экрана, что идёт задача.
  if (job && job.status === 'running') {
    chip.hidden = false;
    chip.className = 'jobchip';
    chip.innerHTML = `${icon('spin', 'mark')} <span class="grow" style="text-align:left">${escapeHtml(baseName(job.input))}</span>`;
  } else if (job) {
    chip.hidden = false;
    chip.className = `jobchip ${job.status === 'done' ? 'done' : 'error'}`;
    chip.innerHTML = `${icon(job.status === 'done' ? 'check' : 'x', 'mark')} <span class="grow" style="text-align:left">${escapeHtml(baseName(job.input))}</span>`;
  } else {
    chip.hidden = true;
  }
  chip.onclick = () => job && openProject(job.input);

  const stepper = $('#stepper');
  const result = $('#jobResult');
  const status = $('#projectStatus');

  $('#cancelJob').disabled = !(mine && job.status === 'running');
  $('#startJob').classList.toggle('busy', Boolean(mine && job.status === 'running'));

  if (!mine) {
    // Задача не идёт: показываем, что уже есть в кэше для этого файла.
    const known = state.projects.find((project) => project.input === state.project);
    const done = new Set(known?.stages ?? []);
    const finished = done.has('s7');
    status.className = `pill ${finished ? 'ok' : done.size ? 'accent' : ''}`;
    status.textContent = finished ? t('library.state.dubbed') : done.size ? t('project.stagesDone', { count: done.size }) : t('library.state.fresh');
    stepper.innerHTML = state.stages
      .map((stage) => {
        const ready = done.has(stage.id);
        return `<div class="step ${ready ? 'done' : ''}"><svg class="mark"><use href="#i-${ready ? 'check' : 'dot'}" /></svg><b>${t(STAGE_SHORT[stage.id])}</b><span class="sub">${t(ready ? 'stage.state.cached' : 'stage.state.never')}</span></div>`;
      })
      .join('');
    result.innerHTML = '';
    $('#actionHint').textContent = finished
      ? t('project.hint.done')
      : t('project.hint.fresh');
    return;
  }

  const labels = { running: t('job.running'), done: t('job.done'), error: t('job.error'), cancelled: t('job.cancelled') };
  const tone = { running: 'accent', done: 'ok', error: 'bad', cancelled: 'warn' }[job.status];
  status.className = `pill ${tone}`;
  status.textContent = labels[job.status];
  $('#actionHint').textContent = '';

  const planned = new Map(job.stages.map((stage) => [stage.id, stage]));
  stepper.innerHTML = state.stages
    .map((stage) => {
      const item = planned.get(stage.id);
      if (!item) return `<div class="step skipped"><svg class="mark"><use href="#i-dot" /></svg><b>${t(STAGE_SHORT[stage.id])}</b><span class="sub">${t('stage.state.skipped')}</span></div>`;
      const mark = item.state === 'done' ? 'check' : item.state === 'running' ? 'spin' : 'dot';
      // Что стадия делает, сервер присылает ключом словаря: сама строка у него
      // русская — её печатает командная строка, где язык не выбирают.
      const doing = item.progress?.phrase
        ? t(item.progress.phrase.key, item.progress.phrase.params ?? {})
        : item.progress?.detail;
      const sub =
        item.state === 'done'
          ? (item.provider === 'кэш' ? t('work.cached') : (item.provider ?? t('stage.state.done')))
          : item.state === 'running'
            ? (doing ?? t('stage.state.running'))
            : t('stage.state.pending');
      // Полоса: с известной долей — заполняется, без неё — бежит, чтобы было видно, что процесс жив.
      const percent = item.progress?.percent;
      const bar =
        item.state === 'running'
          ? `<div class="bar ${percent == null ? 'indeterminate' : ''}"><i style="width:${percent == null ? 30 : percent}%"></i></div>`
          : '';
      const time =
        item.state === 'running' && item.startedAt
          ? `<span class="time" data-started="${escapeAttr(item.startedAt)}">${formatElapsed(Date.now() - Date.parse(item.startedAt))}</span>`
          : item.state === 'done' && item.durationMs != null && item.provider !== 'кэш'
            ? `<span class="time">${formatElapsed(item.durationMs)}</span>`
            : '';
      const pct = item.state === 'running' && percent != null ? `<span class="pct">${percent}%</span>` : '';
      return `<div class="step ${item.state}"><svg class="mark"><use href="#i-${mark}" /></svg><b>${t(STAGE_SHORT[stage.id])}${pct}</b><span class="sub">${escapeHtml(sub)}</span>${bar}${time}</div>`;
    })
    .join('');

  // Сообщения о прогоне можно закрыть: на длинном материале их набирается
  // столько, что за ними не видно ни плеера, ни таблицы. Закрытое помнится до
  // следующего запуска, иначе оно возвращалось бы на каждой перерисовке.
  const notices = [];
  if (job.error) notices.push({ tone: 'error', text: job.error });
  if (job.output) notices.push({ tone: 'ok', text: t('job.result', { path: job.output }) });
  for (const warning of job.warnings ?? []) notices.push({ tone: 'warn', text: warning });

  result.innerHTML = notices
    .filter((notice) => !dismissedNotices.has(notice.text))
    .map(
      (notice) =>
        `<div class="notice ${notice.tone}"><span class="grow">${escapeHtml(notice.text)}</span>` +
        `<button class="notice-close" data-dismiss="${escapeAttr(notice.text)}" title="${escapeAttr(t('job.dismiss'))}" aria-label="${escapeAttr(t('job.dismiss'))}">${icon('x')}</button></div>`,
    )
    .join('');

  result.querySelectorAll('[data-dismiss]').forEach((button) =>
    button.addEventListener('click', () => {
      dismissedNotices.add(button.dataset.dismiss);
      renderJob();
    }),
  );
}

/** Закрытые сообщения прогона; сбрасываются при новом запуске. */
const dismissedNotices = new Set();

/** «1:23» — сколько стадия уже идёт; счётчик обновляется раз в секунду. */
function formatElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

setInterval(() => {
  $$('.step .time[data-started]').forEach((element) => {
    element.textContent = formatElapsed(Date.now() - Date.parse(element.dataset.started));
  });
}, 1000);

// --- журнал ----------------------------------------------------------------

const logView = $('#logView');
function appendLog(record) {
  if (record.level === 'debug' && !$('#showDebug').checked) return;
  const line = document.createElement('span');
  line.className = record.kind === 'stage' ? 'stage-line' : record.level;
  line.textContent = `${record.kind === 'step' ? '   ' : ''}${record.text}\n`;
  logView.appendChild(line);
  while (logView.childNodes.length > 800) logView.removeChild(logView.firstChild);
  logView.scrollTop = logView.scrollHeight;
}
$('#clearLog').addEventListener('click', () => { logView.textContent = ''; });

// --- куда сохранить итог ---------------------------------------------------

const outMode = () => $$('input[name="outMode"]').find((radio) => radio.checked)?.value ?? 'beside';

/** Имя итогового файла по имени входа: как его построит стадия сведения. */
function outputFileName(input) {
  if (!input) return '';
  const name = baseName(input);
  const dot = name.lastIndexOf('.');
  const stem = /^https?:/i.test(input) ? 'dubbed' : dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.ru.mp4`;
}

function renderOutPlace() {
  const folder = outMode() === 'folder' ? state.outDir : state.defaultOutputDir;
  $('#outFolderRow').hidden = outMode() !== 'folder';
  const preview = $('#outPreview');
  if (outMode() === 'folder' && !state.outDir) {
    preview.textContent = t('project.outPickFirst');
    return;
  }
  preview.textContent = folder ? t('project.outFile', { path: `${folder}\\${outputFileName(state.project)}` }) : '';
}

$$('input[name="outMode"]').forEach((radio) => radio.addEventListener('change', renderOutPlace));

$('#pickOutDir').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const chosen = await pickFolderPath();
    if (!chosen) return;
    state.outDir = chosen;
    $('#outDir').value = chosen;
    renderOutPlace();
  }).catch(showError),
);

// --- реплики ---------------------------------------------------------------

// Меркой распоряжается конвейер, здесь она только применяется: место реплики
// (слот плюс занимаемая пауза), замеренный темп с надбавкой на реплику и
// допуск из настроек. Пока эта таблица считала по-своему — по голому слоту,
// без надбавки и с допуском, вписанным в код, — она красила красным реплики,
// которые конвейер укладывал без единой правки.
function fitInfo(segment) {
  if (!segment.text_ru) return { cls: '', label: '—' };
  const ruler = state.fit;
  const room = ruler.room[segment.id] ?? segment.end - segment.start;
  const estimated = ruler.overheadSeconds + segment.text_ru.trim().length / ruler.charsPerSecond;
  const delta = estimated - room;
  const allowed = Math.max(room * ruler.tolerance, ruler.toleranceFloorSeconds);
  const label = t('common.seconds', { value: estimated.toFixed(2) });
  if (Math.abs(delta) <= allowed) return { cls: 'ok', label };
  return { cls: delta > 0 ? 'long' : 'short', label: `${label} (${delta > 0 ? '+' : ''}${delta.toFixed(2)})` };
}

/*
 * Ширины колонок таблицы реплик.
 *
 * Колонок десять, и у каждого материала своя нужда: где-то важен длинный
 * оригинал, где-то — укладка. Поэтому ширины тянутся мышью за правый край
 * заголовка и запоминаются на этом устройстве. Раскладка таблицы фиксированная,
 * поэтому последняя колонка больше не уезжает за край карточки.
 */
const SEGMENT_COLUMNS = [
  { key: 'index', width: 46, min: 36 },
  { key: 'start', width: 96, min: 70 },
  { key: 'end', width: 96, min: 70 },
  { key: 'slot', width: 66, min: 52 },
  { key: 'speaker', width: 152, min: 90 },
  { key: 'source', width: 280, min: 120 },
  { key: 'target', width: 280, min: 120 },
  { key: 'fit', width: 116, min: 80 },
  { key: 'flags', width: 96, min: 60 },
  { key: 'listen', width: 150, min: 90 },
];
const COLUMN_STORE = 'dubpipe.segmentColumns';

function columnWidths() {
  const defaults = SEGMENT_COLUMNS.map((column) => column.width);
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_STORE) ?? 'null');
    if (!Array.isArray(saved) || saved.length !== defaults.length) return defaults;
    return saved.map((value, index) =>
      Number.isFinite(value) ? Math.max(SEGMENT_COLUMNS[index].min, Math.round(value)) : defaults[index],
    );
  } catch {
    // Приватное окно или запрет на хранилище — просто берём умолчания.
    return defaults;
  }
}

function saveColumnWidths(widths) {
  try {
    localStorage.setItem(COLUMN_STORE, JSON.stringify(widths));
  } catch {
    // Не сохранилось — не беда: ширины действуют до конца сеанса.
  }
}

function renderColumns() {
  const group = $('#segmentsTable colgroup');
  if (!group) return;
  const widths = columnWidths();
  group.innerHTML = widths.map((width) => `<col style="width:${width}px" />`).join('');

  $$('#segmentsTable thead th').forEach((cell, index) => {
    cell.querySelector('.col-grip')?.remove();
    if (index >= SEGMENT_COLUMNS.length - 1) return;
    const grip = document.createElement('div');
    grip.className = 'col-grip';
    grip.title = t('segments.columnsHint');
    grip.addEventListener('pointerdown', (event) => startColumnDrag(event, index, grip));
    // Двойной щелчок по тянучке возвращает исходные ширины.
    grip.addEventListener('dblclick', () => {
      saveColumnWidths(SEGMENT_COLUMNS.map((column) => column.width));
      renderColumns();
      toast(t('segments.columnsReset'), 'ok');
    });
    cell.appendChild(grip);
  });
}

function startColumnDrag(event, index, grip) {
  event.preventDefault();
  const widths = columnWidths();
  const startX = event.clientX;
  const startWidth = widths[index];
  const cols = $$('#segmentsTable colgroup col');
  grip.classList.add('active');
  document.body.classList.add('col-resizing');
  grip.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    const width = Math.max(SEGMENT_COLUMNS[index].min, Math.round(startWidth + (moveEvent.clientX - startX)));
    widths[index] = width;
    if (cols[index]) cols[index].style.width = `${width}px`;
  };
  const stop = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', stop);
    grip.removeEventListener('pointercancel', stop);
    grip.classList.remove('active');
    document.body.classList.remove('col-resizing');
    saveColumnWidths(widths);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
}

function renderSegments() {
  renderColumns();
  const body = $('#segmentsTable tbody');
  if (state.segments.length === 0) {
    body.innerHTML = `<tr><td colspan="10"><span class="meta">${t('segments.empty')}</span></td></tr>`;
    return;
  }
  body.innerHTML = state.segments
    .map((segment, index) => {
      const fit = fitInfo(segment);
      const clip = segment.aligned_file ?? segment.tts_file;
      return `<tr data-index="${index}">
        <td>${segment.id}</td>
        <td class="num"><input type="text" data-field="start" value="${segment.start.toFixed(2)}" /></td>
        <td class="num"><input type="text" data-field="end" value="${segment.end.toFixed(2)}" /></td>
        <td>${(segment.end - segment.start).toFixed(2)}</td>
        <td class="speaker">${speakerCell(segment)}</td>
        <td><textarea data-field="text_en">${escapeHtml(segment.text_en)}</textarea></td>
        <td><textarea data-field="text_ru">${escapeHtml(segment.text_ru ?? '')}</textarea></td>
        <td class="fit ${fit.cls}">${fit.label}${segment.tts_duration ? `<br><span class="meta">${t('segments.synth', { value: segment.tts_duration.toFixed(2) })}</span>` : ''}</td>
        <td><span class="meta">${(segment.flags ?? []).join(', ')}${segment.overlap ? ' overlap' : ''}</span></td>
        <td><button data-play-original="${index}" class="ghost small">${icon('play')} ${t('segments.original')}</button>${clip ? `<button data-play-target="${index}" class="ghost small">${icon('play')} ${t('segments.target')}</button>` : ''}</td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('input, textarea').forEach((field) =>
    field.addEventListener('change', () => {
      const segment = state.segments[Number(field.closest('tr').dataset.index)];
      const key = field.dataset.field;
      if (key === 'start' || key === 'end') {
        const value = Number(field.value.replace(',', '.'));
        if (Number.isFinite(value)) segment[key] = value;
      } else segment[key] = field.value;
      renderSegments();
    }),
  );
  body.querySelectorAll('[data-play-original]').forEach((button) =>
    button.addEventListener('click', () => { const s = state.segments[Number(button.dataset.playOriginal)]; playOriginal(s.start, s.end); }),
  );
  body.querySelectorAll('[data-play-target]').forEach((button) =>
    button.addEventListener('click', () => playTranslated(state.segments[Number(button.dataset.playTarget)])),
  );
  body.querySelectorAll('[data-speaker-pick]').forEach((select) =>
    select.addEventListener('change', () => {
      const segment = state.segments[Number(select.dataset.speakerPick)];
      segment.speaker = select.value === '__new' ? nextSpeakerName() : select.value;
      renderSegments();
      if (review.data) { renderReviewNow(); renderReviewMarks(); }
    }),
  );
}

/** Первое свободное имя вида `speaker_N`. */
function nextSpeakerName() {
  const taken = new Set(state.segments.map((segment) => segment.speaker));
  let n = 0;
  while (taken.has(`speaker_${n}`)) n++;
  return `speaker_${n}`;
}

/** Пол голоса, определённый на S2: буква и подсказка с частотой основного тона. */
function genderMark(speaker) {
  const profile = state.speakers?.[speaker];
  const gender = profile?.gender === 'м' || profile?.gender === 'ж' ? profile.gender : '—';
  const title = profile
    ? t(gender === '—' ? 'review.byRecordUnknown' : gender === 'м' ? 'review.byRecordMale' : 'review.byRecordFemale', {
        hz: profile.f0 ?? '?',
      }).replace(/^ · /, '')
    : t('segments.genderUnknown');
  return `<span class="gender ${gender === 'м' ? 'male' : gender === 'ж' ? 'female' : ''}" title="${escapeAttr(title)}">${gender}</span>`;
}

/**
 * Спикер выбирается из тех, что нашла диаризация, а рядом стоит пол его голоса:
 * по нему сразу видно, мужчине ли достался мужской голос. Свободный ввод не
 * годился — опечатка в имени создавала спикера, которого нет ни у кого в карте
 * голосов, и реплика тихо уезжала на голос по умолчанию.
 */
function speakerCell(segment) {
  const index = state.segments.indexOf(segment);
  const known = [...new Set([...state.segments.map((item) => item.speaker), segment.speaker])].sort();
  const options = known
    .map((name) => `<option value="${escapeAttr(name)}" ${name === segment.speaker ? 'selected' : ''}>${escapeHtml(name)}</option>`)
    .join('');
  return `${genderMark(segment.speaker)}<select data-speaker-pick="${index}">${options}<option value="__new">${t('review.newSpeaker')}</option></select>`;
}

/**
 * Проигрывает перевод этой реплики.
 *
 * Когда дубляж уже собран, крутится он сам — на том месте, где эта реплика
 * звучит в готовом файле, и ровно столько, сколько длится её клип: так слышно
 * не голый синтез, а то, что получилось вместе с фоном. Пока готового файла
 * нет, играет отдельный клип.
 */
let stopReviewAt = null;
function playTranslated(segment) {
  const clip = segment.aligned_file ?? segment.tts_file;
  const video = $('#reviewVideo');
  const duration = segment.aligned_duration ?? segment.tts_duration;

  if (state.output && video.dataset.src) {
    const start = segment.start + (segment.shift_ms ?? 0) / 1000;
    stopReviewAt = duration ? start + duration + 0.05 : null;
    video.currentTime = start;
    video.play();
    $('#review').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (!clip) return;
  const player = $('#player');
  player.src = mediaUrl(clip);
  player.dataset.source = '';
  player.play();
}

let stopAt = null;
function playOriginal(start, end) {
  if (!state.originalAudio) { toast(t('segments.noAudio'), 'warn'); return; }
  const player = $('#player');
  if (player.dataset.source !== state.originalAudio) { player.src = mediaUrl(state.originalAudio); player.dataset.source = state.originalAudio; }
  stopAt = end;
  player.currentTime = start;
  player.play();
}
$('#player').addEventListener('timeupdate', () => {
  const player = $('#player');
  if (stopAt !== null && player.currentTime >= stopAt) { player.pause(); stopAt = null; }
});

async function loadSegments() {
  if (!state.project) return;
  const data = await api(`/api/segments?input=${encodeURIComponent(state.project)}`);
  state.segments = data.segments;
  state.originalAudio = data.originalAudio;
  // Пол голоса определяется на S2 и нужен таблице реплик, а не только режиму
  // просмотра: по нему видно, тем ли голосом озвучен персонаж.
  state.speakers = data.speakers ?? {};
  state.output = data.output ?? null;
  if (data.fit) state.fit = data.fit;
  $('#editorInfo').textContent = data.segments.length ? t('segments.count', { count: data.segments.length }) : '';
  state.defaultOutputDir = data.defaultOutputDir ?? null;
  renderOutPlace();
  $('#player').dataset.source = '';
  renderSegments();
  renderJob();
  setupReview(data);
}

// --- просмотр и правка -----------------------------------------------------
//
// Готовый файл смотрят здесь же; текущая реплика показывается рядом с плеером,
// и всё, что не так — голос спикера, спикер реплики, перевод, громкости, —
// помечается по кнопке. Пометки копятся списком, «Внести правки» сохраняет их
// и перезапускает конвейер с нужной стадии: синтез только для затронутых реплик
// или одно сведение, если менялись лишь громкости.

const review = { data: null, baseline: null, overrides: null, index: -1 };
const MIX_KEYS = { mixBg: 'background_gain_db', mixVoice: 'voice_gain_db', mixDuck: 'duck_db' };

function setupReview(data) {
  const box = $('#review');
  if (!data.output || !state.segments.length) {
    box.hidden = true;
    review.data = null;
    return;
  }
  review.data = data;
  review.overrides = { voices: { ...(data.overrides?.voices ?? {}) }, mix: { ...(data.overrides?.mix ?? {}) } };
  review.baseline = {
    segments: state.segments.map((segment) => ({ speaker: segment.speaker, text_ru: segment.text_ru })),
    overrides: JSON.parse(JSON.stringify(review.overrides)),
  };
  review.index = -1;
  const video = $('#reviewVideo');
  const url = mediaUrl(data.output);
  if (video.dataset.src !== url) {
    video.src = url;
    video.dataset.src = url;
  }
  for (const [id, key] of Object.entries(MIX_KEYS)) {
    $(`#${id}`).value = review.overrides.mix[key] ?? data.mix[key];
  }
  box.hidden = false;
  renderMixLabels();
  renderReviewNow();
  renderReviewMarks();
}

function genderNote(speaker) {
  const profile = review.data?.speakers?.[speaker];
  if (!profile) return '';
  if (profile.gender === 'м' || profile.gender === 'ж') {
    return t(profile.gender === 'м' ? 'review.byRecordMale' : 'review.byRecordFemale', { hz: profile.f0 });
  }
  return t('review.byRecordUnknown');
}

function reviewVoiceFor(speaker) {
  return review.overrides.voices[speaker] ?? review.data.voiceMap[speaker] ?? review.data.defaultVoice;
}

function voiceInfo(name) {
  return (review.data?.voices ?? []).find((voice) => voice.name === name) ?? { name, gender: '—', note: '' };
}

function currentReviewIndex(time) {
  // Реплика, звучащая сейчас; в паузе между репликами — последняя прозвучавшая.
  let found = -1;
  state.segments.forEach((segment, index) => {
    if (segment.start <= time + 0.05) found = index;
  });
  if (found >= 0 && time > state.segments[found].end + 1.5 && (found + 1 < state.segments.length)) return found;
  return found;
}

function renderReviewNow() {
  const box = $('#reviewNow');
  const segment = state.segments[review.index];
  if (!segment) {
    box.innerHTML = `<div class="meta">${t('review.waiting')}</div>`;
    return;
  }
  const speakers = [...new Set(state.segments.map((item) => item.speaker))].sort();
  const voice = voiceInfo(reviewVoiceFor(segment.speaker));
  const opposite = voice.gender === 'м' ? 'ж' : 'м';
  const alternative = (review.data.voices ?? []).find((item) => item.gender === opposite);
  box.innerHTML = `
    <div class="now-head">
      <div class="now-title"><b>${t('review.replica', { id: segment.id })}</b> <span class="meta">${segment.start.toFixed(2)}–${segment.end.toFixed(2)} с</span></div>
      <div class="now-nav">
        <button class="ghost small" id="reviewPrev" title="${escapeAttr(t('review.prev'))}">${t('review.prevShort')}</button>
        <button class="ghost small" id="reviewReplay" title="${escapeAttr(t('review.replay'))}">${icon('play')} ${t('review.replayShort')}</button>
        <button class="ghost small" id="reviewNext" title="${escapeAttr(t('review.next'))}">${t('review.nextShort')}</button>
      </div>
    </div>
    <div class="now-en">${escapeHtml(segment.text_en)}</div>
    <textarea id="reviewText" rows="2" title="${escapeAttr(t('review.textTitle'))}">${escapeHtml(segment.text_ru ?? '')}</textarea>
    <div class="now-row">
      <label>${t('review.speakerLabel')} <select id="reviewSpeaker">${speakers.map((item) => `<option value="${escapeAttr(item)}" ${item === segment.speaker ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}<option value="__new">${t('review.newSpeaker')}</option></select></label>
      <span class="meta">${t('review.voiceIs', { name: escapeHtml(voice.name), gender: voice.gender })}${genderNote(segment.speaker)}</span>
    </div>
    <div class="now-row">
      ${alternative ? `<button class="small" id="reviewGender">${t(voice.gender === 'м' ? 'review.makeFemale' : 'review.makeMale')}</button>` : ''}
      <label>${t('review.voiceOfSpeaker')} <select id="reviewVoice">${(review.data.voices ?? []).map((item) => `<option value="${escapeAttr(item.name)}" ${item.name === voice.name ? 'selected' : ''}>${escapeHtml(item.name)} — ${item.gender}, ${escapeHtml(item.note)}</option>`).join('')}</select></label>
    </div>`;

  const seekTo = (index) => {
    if (index < 0 || index >= state.segments.length) return;
    const video = $('#reviewVideo');
    video.currentTime = Math.max(0, state.segments[index].start - 0.2);
    review.index = index;
    renderReviewNow();
    video.play().catch(() => {});
  };
  $('#reviewPrev').addEventListener('click', () => seekTo(review.index - 1));
  $('#reviewNext').addEventListener('click', () => seekTo(review.index + 1));
  $('#reviewReplay').addEventListener('click', () => seekTo(review.index));
  $('#reviewText').addEventListener('change', (event) => {
    segment.text_ru = event.target.value;
    renderSegments();
    renderReviewMarks();
  });
  $('#reviewSpeaker').addEventListener('change', (event) => {
    let value = event.target.value;
    if (value === '__new') {
      let n = 0;
      while (speakers.includes(`speaker_${n}`)) n++;
      value = `speaker_${n}`;
    }
    segment.speaker = value;
    renderSegments();
    renderReviewNow();
    renderReviewMarks();
  });
  $('#reviewGender')?.addEventListener('click', () => {
    review.overrides.voices[segment.speaker] = alternative.name;
    renderReviewNow();
    renderReviewMarks();
  });
  $('#reviewVoice').addEventListener('change', (event) => {
    review.overrides.voices[segment.speaker] = event.target.value;
    renderReviewNow();
    renderReviewMarks();
  });
}

function reviewMarks() {
  if (!review.data) return [];
  const marks = [];
  state.segments.forEach((segment, index) => {
    const base = review.baseline.segments[index];
    if (!base) return;
    if (base.speaker !== segment.speaker) marks.push({ kind: 'speaker', text: t('review.markSpeaker', { id: segment.id, from: base.speaker, to: segment.speaker }) });
    if ((base.text_ru ?? '') !== (segment.text_ru ?? '')) marks.push({ kind: 'text', text: t('review.markText', { id: segment.id }) });
  });
  const baseVoices = review.baseline.overrides.voices;
  for (const [speaker, voice] of Object.entries(review.overrides.voices)) {
    const before = baseVoices[speaker] ?? review.data.voiceMap[speaker] ?? review.data.defaultVoice;
    if (before !== voice) marks.push({ kind: 'voice', text: t('review.markVoice', { speaker, from: voiceInfo(before).name, to: voiceInfo(voice).name }) });
  }
  for (const [id, key] of Object.entries(MIX_KEYS)) {
    const before = review.baseline.overrides.mix[key] ?? review.data.mix[key];
    const after = review.overrides.mix[key] ?? review.data.mix[key];
    if (before !== after) marks.push({ kind: 'mix', text: `${$(`#${id}`).closest('label').querySelector('span').firstChild.textContent.trim()}: ${before} → ${after} дБ` });
  }
  return marks;
}

function renderReviewMarks() {
  const marks = reviewMarks();
  const box = $('#reviewMarks');
  box.innerHTML = marks.length
    ? `<b>${t('review.marks', { count: marks.length })}</b> ${marks.map((mark) => `<span class="chip mark-${mark.kind}">${escapeHtml(mark.text)}</span>`).join(' ')}`
    : `<span class="meta">${t('review.noMarks')}</span>`;
  $('#reviewApply').disabled = marks.length === 0;
  $('#reviewDiscard').disabled = marks.length === 0;
}

function renderMixLabels() {
  const signed = (value) => `${value > 0 ? '+' : ''}${value} ${t('unit.db')}`;
  $('#mixBgLabel').textContent = signed(Number($('#mixBg').value));
  $('#mixVoiceLabel').textContent = signed(Number($('#mixVoice').value));
  $('#mixDuckLabel').textContent = signed(Number($('#mixDuck').value));
}

for (const [id, key] of Object.entries(MIX_KEYS)) {
  $(`#${id}`).addEventListener('input', (event) => {
    if (!review.data) return;
    review.overrides.mix[key] = Number(event.target.value);
    renderMixLabels();
    renderReviewMarks();
  });
}

$('#reviewVideo').addEventListener('timeupdate', (event) => {
  // Прослушивание одной реплики: доиграли её кусок — останавливаемся.
  if (stopReviewAt !== null && event.target.currentTime >= stopReviewAt) {
    event.target.pause();
    stopReviewAt = null;
  }
  if (!review.data) return;
  const index = currentReviewIndex(event.target.currentTime);
  if (index !== review.index) {
    review.index = index;
    renderReviewNow();
  }
});

$('#reviewDiscard').addEventListener('click', () => {
  if (!review.data) return;
  state.segments.forEach((segment, index) => {
    const base = review.baseline.segments[index];
    if (base) { segment.speaker = base.speaker; segment.text_ru = base.text_ru; }
  });
  review.overrides = JSON.parse(JSON.stringify(review.baseline.overrides));
  for (const [id, key] of Object.entries(MIX_KEYS)) $(`#${id}`).value = review.overrides.mix[key] ?? review.data.mix[key];
  renderMixLabels();
  renderSegments();
  renderReviewNow();
  renderReviewMarks();
});

$('#reviewApply').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const result = await post('/api/project/review', { input: state.project, segments: state.segments, overrides: review.overrides });
    if (!result.fromStage) { toast(t('review.nothingToApply'), 'warn'); return; }
    state.job = await post('/api/jobs', { input: state.project, fromStage: result.fromStage });
    renderJob();
    toast(
      result.fromStage === 's5'
        ? t('review.applied', { count: result.affected.length })
        : t('review.appliedMix'),
      'ok',
      6000,
    );
  }).catch(showError),
);

$('#reviewReset').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    if (!window.confirm(t('review.resetConfirm'))) return;
    await post('/api/cache/clear', { input: state.project });
    toast(t('review.resetDone'), 'ok', 6000);
    await loadSegments().catch(() => {});
  }).catch(showError),
);

$('#reloadSegments').addEventListener('click', (event) => withBusy(event.currentTarget, loadSegments).catch(showError));
$('#saveSegments').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    if (!state.segments.length) { toast(t('segments.nothingToSave'), 'warn'); return; }
    const result = await put('/api/segments', { input: state.project, segments: state.segments });
    toast(t('segments.saved', { count: result.count }), 'ok', 8000);
  }).catch(showError),
);

// --- субтитры --------------------------------------------------------------
//
// Титры — отдельная сущность: реплики нарезаны под озвучку, а субтитры живут
// по правилам чтения (две строки, ограничение символов, скорость чтения).
// Здесь их правят, видят замечания и пишут в SRT.

const subs = { data: null, kind: 'source', dirty: false, active: -1 };

const PROBLEM_LABELS = {
  too_fast: 'problem.too_fast',
  too_short: 'problem.too_short',
  too_long: 'problem.too_long',
  line_overflow: 'problem.line_overflow',
  too_many_lines: 'problem.too_many_lines',
  overlap: 'problem.overlap',
};

const subsKind = () => $$('input[name="subKind"]').find((radio) => radio.checked)?.value ?? 'source';
const currentSubs = () => subs.data?.languages.find((item) => item.kind === subs.kind) ?? null;

function timecode(seconds) {
  const value = Math.max(0, seconds);
  const ms = Math.round((value % 1) * 1000);
  const total = Math.floor(value);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}.${String(ms).padStart(3, '0')}`;
}

/** «01:23.400» или «83.4» — принимаем оба вида, чтобы правка не спотыкалась. */
function parseTimecode(text) {
  const trimmed = String(text).trim().replace(',', '.');
  const parts = trimmed.split(':').map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

async function loadSubtitles() {
  if (!state.project) return;
  subs.data = await api(`/api/subtitles?input=${encodeURIComponent(state.project)}`);
  const source = subs.data.languages.find((item) => item.kind === 'source');
  $('#subSourceLabel').textContent = source ? t('subs.sourceWithLang', { name: source.name }) : t('subs.source');
  subs.kind = subsKind();
  subs.dirty = false;
  const video = $('#subsVideo');
  const preview = $('#subsPreview');
  if (subs.data.source) {
    const url = mediaUrl(subs.data.source);
    if (video.dataset.src !== url) { video.src = url; video.dataset.src = url; }
    preview.hidden = false;
  } else {
    preview.hidden = true;
  }
  renderSubtitles();
}

function renderSubtitles() {
  const body = $('#subsTable tbody');
  const current = currentSubs();
  const cues = current?.cues ?? [];

  if (!subs.data?.hasSegments) {
    body.innerHTML = `<tr><td colspan="7"><span class="meta">${t('subs.none')}</span></td></tr>`;
    $('#subsSummary').textContent = '';
    $('#subsFile').textContent = '';
    return;
  }
  if (cues.length === 0) {
    body.innerHTML = `<tr><td colspan="7"><span class="meta">${t(subs.kind === 'target' ? 'subs.noneTarget' : 'subs.noneSource')}</span></td></tr>`;
  } else {
    body.innerHTML = cues
      .map((cue, index) => {
        const duration = cue.end - cue.start;
        const chars = cue.lines.join(' ').replace(/\s+/g, ' ').trim().length;
        const cps = duration > 0 ? chars / duration : 0;
        const problems = (cue.problems ?? []).map((code) => PROBLEM_LABELS[code] ?? code);
        return `<tr data-cue="${index}" class="${problems.length ? 'has-problem' : ''} ${index === subs.active ? 'playing' : ''}">
          <td>${cue.index}</td>
          <td class="num"><input type="text" data-cue-field="start" value="${timecode(cue.start)}" /></td>
          <td class="num"><input type="text" data-cue-field="end" value="${timecode(cue.end)}" /></td>
          <td class="num">${t('common.seconds', { value: duration.toFixed(2) })}<br><span class="meta">${t('subs.cps', { value: cps.toFixed(1) })}</span></td>
          <td><textarea data-cue-field="lines" rows="2">${escapeHtml(cue.lines.join('\n'))}</textarea></td>
          <td>${problems.length ? `<span class="meta bad">${escapeHtml(problems.join(', '))}</span>` : '<span class="meta ok">—</span>'}</td>
          <td><button class="ghost small" data-cue-play="${index}" title="${escapeAttr(t('subs.playHere'))}">${icon('play')}</button></td>
        </tr>`;
      })
      .join('');
  }

  body.querySelectorAll('[data-cue-field]').forEach((field) =>
    field.addEventListener('change', (event) => {
      const row = event.target.closest('[data-cue]');
      const cue = currentSubs().cues[Number(row.dataset.cue)];
      const kind = event.target.dataset.cueField;
      if (kind === 'lines') {
        cue.lines = event.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
      } else {
        const parsed = parseTimecode(event.target.value);
        if (parsed === null) { toast(t('subs.badTime'), 'warn'); renderSubtitles(); return; }
        cue[kind] = parsed;
      }
      subs.dirty = true;
      renderSubtitles();
    }),
  );
  body.querySelectorAll('[data-cue-play]').forEach((button) =>
    button.addEventListener('click', () => {
      const cue = currentSubs().cues[Number(button.dataset.cuePlay)];
      const video = $('#subsVideo');
      if (!video.src) return;
      video.currentTime = Math.max(0, cue.start - 0.3);
      video.play().catch(() => {});
    }),
  );

  const problems = cues.filter((cue) => (cue.problems ?? []).length > 0).length;
  $('#subsSummary').textContent = cues.length
    ? `${t('subs.summary', { count: cues.length })}${problems ? t('subs.summary.problems', { count: problems }) : t('subs.summary.clean')}${subs.dirty ? t('subs.summary.dirty') : ''}`
    : '';
  $('#subsFile').textContent = current ? `${current.file}${current.exists ? '' : t('subs.notWritten')}` : '';
  $('#saveSubtitles').disabled = cues.length === 0;
  $('#rebuildSubtitles').disabled = !current?.edited;
}

$$('input[name="subKind"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    if (subs.dirty && !window.confirm(t('subs.switchConfirm'))) {
      $$('input[name="subKind"]').forEach((other) => { other.checked = other.value === subs.kind; });
      return;
    }
    subs.kind = subsKind();
    subs.dirty = false;
    loadSubtitles().catch(showError);
  }),
);

async function startSubtitles() {
  if (!state.project) return;
  state.job = await post('/api/jobs', {
    input: state.project,
    mode: 'subtitles',
    outDir: outMode() === 'folder' && state.outDir ? state.outDir : undefined,
  });
  renderJob();
  toast(t('subs.started'), 'ok', 6000);
}

$('#makeSubtitles').addEventListener('click', (event) => withBusy(event.currentTarget, startSubtitles).catch(showError));

$('#saveSubtitles').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const current = currentSubs();
    if (!current || current.cues.length === 0) return;
    const result = await put('/api/subtitles', {
      input: state.project,
      kind: subs.kind,
      cues: current.cues.map((cue) => ({ start: cue.start, end: cue.end, lines: cue.lines, segmentId: cue.segmentId })),
    });
    subs.dirty = false;
    toast(t('subs.saved', { count: result.count, path: result.file }), 'ok', 7000);
    await loadSubtitles();
  }).catch(showError),
);

$('#rebuildSubtitles').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    if (!window.confirm(t('subs.rebuildConfirm'))) return;
    await post('/api/subtitles/rebuild', { input: state.project, kind: subs.kind });
    subs.dirty = false;
    await loadSubtitles();
    toast(t('subs.rebuilt'), 'ok');
  }).catch(showError),
);

// Предпросмотр: показываем титр, который звучит сейчас, и подсвечиваем его строку.
$('#subsVideo').addEventListener('timeupdate', (event) => {
  const cues = currentSubs()?.cues ?? [];
  const time = event.target.currentTime;
  const index = cues.findIndex((cue) => time >= cue.start && time <= cue.end);
  $('#subsOverlayText').textContent = index >= 0 ? cues[index].lines.join('\n') : '';
  if (index !== subs.active) {
    subs.active = index;
    $$('#subsTable tbody tr').forEach((row) => row.classList.toggle('playing', Number(row.dataset.cue) === index));
    if (index >= 0) $(`#subsTable tbody tr[data-cue="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }
});

// --- сравнение моделей -----------------------------------------------------

async function loadCatalog() {
  const search = $('#modelSearch').value.trim();
  const free = $('#modelFree').checked ? '1' : '0';
  try {
    const data = await api(`/api/models?search=${encodeURIComponent(search)}&free=${free}&limit=40`);
    const options = data.models.map((model) => `<option value="${escapeAttr(model.id)}"></option>`).join('');
    $('#modelList').innerHTML = options;
    $('#modelCatalog').innerHTML = data.models
      .map((model) => `<span class="chip ${model.free ? 'free' : ''}" data-model="${escapeAttr(model.id)}">${escapeHtml(model.id)}${model.free ? ' · бесплатно' : ` · $${(model.promptPrice * 1e6).toFixed(2)}/$${(model.completionPrice * 1e6).toFixed(2)}`}</span>`)
      .join('');
    $('#modelCatalog').querySelectorAll('[data-model]').forEach((chip) =>
      chip.addEventListener('click', () => {
        const field = $('#compareModels');
        const current = field.value.split(',').map((item) => item.trim()).filter(Boolean);
        if (!current.includes(chip.dataset.model)) current.push(chip.dataset.model);
        field.value = current.join(', ');
      }),
    );
  } catch (error) {
    $('#modelCatalog').innerHTML = `<div class="notice warn">${escapeHtml(t('compare.unavailable', { error: error.message }))}</div>`;
  }
}
$('#modelSearch').addEventListener('change', () => loadCatalog());
$('#modelFree').addEventListener('change', () => loadCatalog());

$('#runCompare').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const models = $('#compareModels').value.split(',').map((item) => item.trim()).filter(Boolean);
    if (models.length === 0) { toast(t('compare.needModel'), 'warn'); return; }
    if (!state.segments.length) { toast(t('compare.needSegments'), 'warn'); return; }
    $('#compareResult').innerHTML = `<div class="notice">${t('compare.running')}</div>`;
    const report = await post('/api/compare', { input: state.project, models, limit: Number($('#compareLimit').value) || 10 });
    renderComparison(report);
    toast(t('compare.done'), 'ok');
  }).catch((error) => { $('#compareResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; showError(error); }),
);

function renderComparison(report) {
  const ok = report.models.filter((model) => model.ok);
  const rows = [...report.models].sort((a, b) => (a.ok === b.ok ? b.stats.share - a.stats.share : a.ok ? -1 : 1));
  const summary = `<div class="table-wrap"><table>
    <thead><tr><th>${t('compare.col.model')}</th><th>${t('compare.col.withinTolerance')}</th><th>${t('compare.col.time')}</th><th>${t('compare.col.tokens')}</th><th>${t('compare.col.cost')}</th><th></th></tr></thead>
    <tbody>${rows.map((row) => row.ok
      ? `<tr><td>${escapeHtml(row.model)}</td><td>${row.stats.withinTolerance}/${row.stats.total} (${Math.round(row.stats.share * 100)}%)</td><td>${(row.elapsedMs / 1000).toFixed(1)} с</td><td>${row.usage.promptTokens + row.usage.completionTokens}</td><td>${row.costUsd ? '$' + row.costUsd.toFixed(5) : 'бесплатно'}</td><td><button class="small" data-apply="${escapeAttr(row.model)}">Применить</button></td></tr>`
      : `<tr><td>${escapeHtml(row.model)}</td><td colspan="5" class="fit long">${escapeHtml(row.error ?? t('common.error'))}</td></tr>`).join('')}</tbody></table></div>`;

  const lines = (ok[0]?.lines ?? []).map((line, index) => `
    <h2>${escapeHtml(t('compare.slot', { id: line.id, slot: line.slot.toFixed(2), text: line.text_en }))}</h2>
    <div class="table-wrap"><table><tbody>${ok.map((model) => {
      const c = model.lines[index];
      return c ? `<tr><td class="meta">${escapeHtml(model.model)}</td><td class="fit ${c.fits ? 'ok' : 'long'}">${c.fits ? '✓' : '✗'}</td><td>${escapeHtml(c.text_ru)}</td></tr>` : '';
    }).join('')}</tbody></table></div>`).join('');

  $('#compareResult').innerHTML = summary + lines;
  $('#compareResult').querySelectorAll('[data-apply]').forEach((button) =>
    button.addEventListener('click', (event) =>
      withBusy(event.currentTarget, async () => {
        const chosen = report.models.find((model) => model.model === button.dataset.apply);
        const byId = new Map(chosen.lines.map((line) => [line.id, line.text_ru]));
        for (const segment of state.segments) { const text = byId.get(segment.id); if (text) segment.text_ru = text; }
        await put('/api/segments', { input: state.project, segments: state.segments });
        renderSegments();
        toast(t('compare.applied', { model: chosen.model }), 'ok', 8000);
      }).catch(showError),
    ),
  );
}

// --- настройки -------------------------------------------------------------

const SLIDER_LABELS = {
  'mix.background_gain_db': (v) => `${v > 0 ? '+' : ''}${v} дБ${v <= -20 ? ' — почти без фона' : v >= 0 ? ' — фон на уровне речи' : ''}`,
  'mix.voice_gain_db': (v) => `${v > 0 ? '+' : ''}${v} дБ`,
  'alignment.max_tempo': (v) => `до ${Number(v).toFixed(2)}× — ${v <= 1.15 ? 'почти незаметно' : v <= 1.3 ? 'заметно, но естественно' : 'уже торопливо'}`,
};
const SLIDER_TARGETS = { 'mix.background_gain_db': '#bgLabel', 'mix.voice_gain_db': '#voiceLabel', 'alignment.max_tempo': '#tempoLabel' };

function showSettingsGroup(name) {
  $$('#settingsNav button').forEach((button) => button.classList.toggle('active', button.dataset.group === name));
  $$('#settingsForm fieldset').forEach((set) => set.classList.toggle('active', set.dataset.group === name));
}
$$('#settingsNav button').forEach((button) => button.addEventListener('click', () => showSettingsGroup(button.dataset.group)));

function fieldValue(field) {
  if (field.type === 'checkbox') return field.checked;
  if (field.type === 'number' || field.type === 'range') return field.value === '' ? null : Number(field.value);
  return field.value;
}

function applyProfileVisibility(profile) {
  $$('[data-only]').forEach((element) => { element.hidden = element.dataset.only !== profile; });
}

/*
 * Списки устройств в настройках строятся по тому, что нашлось в системе.
 *
 * Раньше в них стояли все мыслимые варианты: «видеокарта», «встроенная
 * видеокарта», «отдельная видеокарта», CUDA. На машине с одной встроенной
 * Radeon это четыре способа сказать одно и то же и ни одного способа понять,
 * что выберется, — а выбрав CUDA там, где нет NVIDIA, человек молча получал
 * расчёт на процессоре. Теперь у каждого устройства своё имя, а того, чего в
 * системе нет, в списке не появляется.
 */
const DEVICE_FIELDS = {
  'asr.backend': 'backend',
  'asr.diarization.device': 'device',
  'separation.device': 'device',
};

function renderDeviceOptions(config = state.config) {
  if (!state.devices) return;
  for (const [key, list] of Object.entries(DEVICE_FIELDS)) {
    const select = $(`#settingsForm [data-key="${key}"]`);
    const options = state.devices[list];
    if (!select || !options) continue;
    const chosen = config ? getPath(config, key) : select.value;
    select.innerHTML = options
      .map((option) => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.name ?? t(option.key))}</option>`)
      .join('');
    // Устройство из настроек могло исчезнуть — например, файл настроек принесли
    // с другой машины. Молча подменять выбор нельзя, поэтому он остаётся видимым.
    if (chosen && !options.some((option) => option.value === chosen)) {
      select.insertAdjacentHTML(
        'beforeend',
        `<option value="${escapeAttr(chosen)}">${escapeHtml(t('settings.device.missing', { value: chosen }))}</option>`,
      );
    }
    if (chosen) select.value = chosen;
  }
}

async function loadDevices() {
  state.devices = await api('/api/devices');
  renderDeviceOptions();
}

function fillForm(config) {
  state.config = config;
  state.dirty = {};
  $('#savebar').hidden = true;
  renderDeviceOptions(config);

  $$('#settingsForm [data-key]').forEach((field) => {
    const value = getPath(config, field.dataset.key);
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value ?? '';
    field.closest('.opt')?.classList.remove('invalid');
    field.closest('.opt')?.querySelector('.error')?.remove();
    const label = SLIDER_TARGETS[field.dataset.key];
    if (label) $(label).textContent = SLIDER_LABELS[field.dataset.key](field.value);
  });

  $$('input[name="profile"]').forEach((radio) => { radio.checked = radio.value === config.profile; });
  applyProfileVisibility(config.profile);
  renderVoiceMap(config);
}

function markDirty(key, value) {
  state.dirty[key] = value;
  $('#savebar').hidden = false;
  $('#saveNote').textContent = t('settings.dirtyCount', { count: Object.keys(state.dirty).length });
}

$$('#settingsForm [data-key]').forEach((field) => {
  const handler = () => {
    markDirty(field.dataset.key, fieldValue(field));
    const label = SLIDER_TARGETS[field.dataset.key];
    if (label) $(label).textContent = SLIDER_LABELS[field.dataset.key](field.value);
  };
  field.addEventListener(field.type === 'range' ? 'input' : 'change', handler);
});

$$('input[name="profile"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    markDirty('profile', radio.value);
    markDirty('translate.engine', radio.value === 'offline' ? 'ollama' : 'kilo-gateway');
    applyProfileVisibility(radio.value);
  }),
);

$('#configText').addEventListener('input', () => { state.yamlDirty = true; $('#savebar').hidden = false; $('#saveNote').textContent = t('settings.yamlDirty'); });

function renderVoiceMap(config) {
  const voices = state.voices ?? [];
  const map = config.tts.voice_map ?? {};
  const speakers = Array.from(new Set(['speaker_0', 'speaker_1', ...Object.keys(map)]));
  $('#voiceMap').innerHTML = speakers
    .map((speaker) => `<div class="row nowrap"><span class="mono" style="width:90px">${escapeHtml(speaker)}</span>
      <select data-voicemap="${speaker}"><option value="">${t('settings.asDefault')}</option>${voices.map((v) => `<option value="${v.name}" ${map[speaker] === v.name ? 'selected' : ''}>${escapeHtml(v.name)} (${v.gender})</option>`).join('')}</select></div>`)
    .join('');
  $('#voiceMap').querySelectorAll('[data-voicemap]').forEach((select) =>
    select.addEventListener('change', () => {
      const next = { ...(state.dirty['tts.voice_map'] ?? map) };
      if (select.value) next[select.dataset.voicemap] = select.value; else delete next[select.dataset.voicemap];
      markDirty('tts.voice_map', next);
    }),
  );
}

// --- модель перевода в настройках: поле с подсказками по всему каталогу ------

state.catalog = [];

function priceLabel(model) {
  if (model.free) return t('settings.free');
  return `$${(model.promptPrice * 1e6).toFixed(2)} / $${(model.completionPrice * 1e6).toFixed(2)}`;
}

/** Подсветка совпадения: каждое слово запроса — отдельно, чтобы «claude 4.5» находило «claude-sonnet-4.5». */
function highlight(text, terms) {
  let html = escapeHtml(text);
  for (const term of terms) {
    if (!term) continue;
    const pattern = new RegExp(escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    html = html.replace(pattern, (match) => `<mark>${match}</mark>`);
  }
  return html;
}

const MODEL_LIST_LIMIT = 60;
const combo = { open: false, active: -1, items: [] };

function matchingModels(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const wantFree = terms.includes('free') || terms.includes('бесплатно');
  const rest = terms.filter((term) => term !== 'free' && term !== 'бесплатно');
  const hit = (model) =>
    rest.every((term) => model.id.toLowerCase().includes(term) || (model.name ?? '').toLowerCase().includes(term)) &&
    (!wantFree || model.free);
  const matched = state.catalog.filter(hit);
  // Сначала те, у кого совпадение в начале имени: «claude» → anthropic/claude-… раньше, чем …-claude-…
  const rank = (model) => {
    const short = model.id.toLowerCase().split('/').pop();
    return rest.length && rest.some((term) => short.startsWith(term)) ? 0 : 1;
  };
  matched.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  return { items: matched.slice(0, MODEL_LIST_LIMIT), total: matched.length, terms: rest };
}

function renderModelList() {
  const input = $('#settingsModel');
  const list = $('#settingsModelList');
  const { items, total, terms } = matchingModels(input.value);
  combo.items = items;
  if (combo.active >= items.length) combo.active = items.length ? 0 : -1;
  if (!state.catalog.length) {
    list.innerHTML = `<div class="combo-empty">${t('settings.catalogEmpty')}</div>`;
  } else if (!items.length) {
    list.innerHTML = `<div class="combo-empty">${t('settings.catalogNoMatch')}</div>`;
  } else {
    list.innerHTML =
      items
        .map(
          (model, index) => `<div class="combo-item ${index === combo.active ? 'active' : ''} ${model.id === state.config?.translate?.model ? 'current' : ''}" data-index="${index}" role="option">
          <span class="id">${highlight(model.id, terms)}</span>
          <span class="price ${model.free ? 'free' : ''}">${escapeHtml(priceLabel(model))}</span>
        </div>`,
        )
        .join('') + (total > items.length ? `<div class="combo-empty">${t('settings.catalogMore', { count: total - items.length })}</div>` : '');
  }
  list.querySelectorAll('[data-index]').forEach((item) => {
    // mousedown, а не click: blur поля закрыл бы список раньше клика.
    item.addEventListener('mousedown', (event) => { event.preventDefault(); chooseModel(items[Number(item.dataset.index)].id); });
    item.addEventListener('mousemove', () => { combo.active = Number(item.dataset.index); markActive(); });
  });
  $('#settingsModelNote').textContent = state.catalog.length
    ? `${t('settings.catalogCount', { count: state.catalog.length })}${input.value.trim() ? t('settings.catalogMatched', { count: total }) : ''}`
    : t('settings.catalogMissing');
}

function markActive() {
  $$('#settingsModelList .combo-item').forEach((item) => item.classList.toggle('active', Number(item.dataset.index) === combo.active));
  $(`#settingsModelList .combo-item[data-index="${combo.active}"]`)?.scrollIntoView({ block: 'nearest' });
}

function openModelList() {
  combo.open = true;
  $('#settingsModelList').hidden = false;
  $('#settingsModel').setAttribute('aria-expanded', 'true');
  renderModelList();
}

function closeModelList() {
  combo.open = false;
  combo.active = -1;
  $('#settingsModelList').hidden = true;
  $('#settingsModel').setAttribute('aria-expanded', 'false');
}

function chooseModel(id) {
  const input = $('#settingsModel');
  input.value = id;
  closeModelList();
  input.dispatchEvent(new Event('change'));
  renderModelList();
}

async function loadSettingsCatalog(refresh = false) {
  try {
    const data = await api(`/api/models?limit=0${refresh ? '&refresh=1' : ''}`);
    state.catalog = data.models;
  } catch (error) {
    state.catalog = [];
    $('#settingsModelNote').textContent = t('settings.catalogFailed', { error: error.message });
  }
}

{
  const input = $('#settingsModel');
  input.addEventListener('focus', openModelList);
  input.addEventListener('input', () => { combo.active = 0; if (combo.open) renderModelList(); else openModelList(); });
  input.addEventListener('blur', closeModelList);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!combo.open) openModelList();
      if (!combo.items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      combo.active = (combo.active + step + combo.items.length) % combo.items.length;
      markActive();
    } else if (event.key === 'Enter') {
      if (combo.open && combo.active >= 0 && combo.items[combo.active]) {
        event.preventDefault();
        chooseModel(combo.items[combo.active].id);
      }
    } else if (event.key === 'Escape') {
      closeModelList();
    }
  });
}

function renderModelCheck(result) {
  const box = $('#settingsModelCheckResult');
  box.hidden = false;
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  const cost = result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : '—';
  const head = result.ok
    ? `<div class="head ok">${icon('check')} ${escapeHtml(t('settings.model.works', { seconds, cost }))}</div>`
    : `<div class="head bad">${icon('x')} ${escapeHtml(t('settings.model.fails', { reason: result.reason ?? t('settings.model.noAnswer') }))}${result.elapsedMs ? ` (${seconds} с)` : ''}</div>`;
  const rows = result.lines
    .map(
      (line) => `<div class="line ${line.text_ru ? (line.fits ? 'fits' : 'long') : 'missing'}">
        <span class="en">${escapeHtml(line.text_en)}</span>
        <span class="ru">${line.text_ru ? escapeHtml(line.text_ru) : t('settings.model.noTranslation')}</span>
      </div>`,
    )
    .join('');
  box.innerHTML = head + rows + (result.ok && result.lines.some((line) => !line.fits) ? `<div class="meta">${t('settings.model.longNote')}</div>` : '');
}

$('#settingsModelCheck').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const model = $('#settingsModel').value.trim();
    if (!model) { toast(t('settings.model.pickFirst'), 'warn'); return; }
    $('#settingsModelCheckResult').hidden = true;
    const result = await post('/api/models/check', { model });
    renderModelCheck(result);
    toast(result.ok ? t('settings.model.ok', { model }) : t('settings.model.bad', { model, reason: result.reason }), result.ok ? 'ok' : 'error', 7000);
  }).catch(showError),
);

$('#settingsModelRefresh').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    await loadSettingsCatalog(true);
    renderModelList();
    toast(t('settings.catalogRefreshed', { count: state.catalog.length }), 'ok');
  }).catch(showError),
);

/** Список языков оригинала: профили приходят с сервера, порядок — по названию. */
function fillSourceLanguages(selected) {
  const select = $('#sourceLanguage');
  const languages = [...(state.languages ?? [])];
  if (selected && !languages.some((item) => item.code === selected)) {
    languages.push({ code: selected, name: selected, nameEn: selected });
  }
  const label = (item) => (window.i18n.language() === 'en' ? item.nameEn : item.name);
  languages.sort((a, b) => label(a).localeCompare(label(b)));
  select.innerHTML = languages
    .map((item) => `<option value="${escapeAttr(item.code)}">${escapeHtml(label(item))} (${escapeHtml(item.code)})</option>`)
    .join('');
  if (selected) select.value = selected;
}

async function loadSettings() {
  const [configData, voices, key, hfToken, stateData] = await Promise.all([
    api('/api/config'), api('/api/voices'), api('/api/key'), api('/api/hf-token'), api('/api/state'), loadSettingsCatalog(),
  ]);
  state.voices = voices.voices;
  $('#defaultVoice').innerHTML = voices.voices.map((v) => `<option value="${v.name}">${escapeHtml(v.name)} — ${v.gender}, ${escapeHtml(v.note)}</option>`).join('');
  $('#configPath').textContent = configData.path + (configData.exists ? '' : t('settings.willBeCreated'));
  $('#configText').value = configData.text;
  $('#cacheDir').textContent = stateData.cacheDir;
  state.yamlDirty = false;
  fillSourceLanguages(configData.parsed.asr.language);
  fillForm(configData.parsed);
  renderModelList();
  renderKey(key);
  renderHfToken(hfToken);
}

function renderHfToken(token) {
  $('#hfTokenStatus').textContent = token.set ? t('settings.savedAs', { masked: token.masked }) : t('settings.notSet');
  $('#hfTokenRemove').disabled = !token.set;
}

$('#hfTokenToggle').addEventListener('click', () => {
  const field = $('#hfTokenInput');
  field.type = field.type === 'password' ? 'text' : 'password';
  $('#hfTokenToggle').textContent = t(field.type === 'password' ? 'common.show' : 'common.hide');
});
$('#hfTokenSave').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const value = $('#hfTokenInput').value.trim();
    if (!value) { toast(t('settings.pasteToken'), 'warn'); return; }
    const result = await put('/api/hf-token', { token: value });
    $('#hfTokenInput').value = '';
    renderHfToken(result);
    renderReadiness(result.readiness);
    toast(t('settings.tokenSaved'), 'ok', 7000);
  }).catch(showError),
);
$('#hfTokenRemove').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const result = await put('/api/hf-token', { token: null });
    renderHfToken(result);
    renderReadiness(result.readiness);
    toast(t('settings.tokenRemoved'), 'ok');
  }).catch(showError),
);

function renderKey(key) {
  $('#keyStatus').textContent = key.set ? t('settings.savedAs', { masked: key.masked }) : t('settings.notSet');
  $('#keyStatus').className = `meta ${key.set ? '' : ''}`;
  $('#keyRemove').disabled = !key.set;
}

$('#keyToggle').addEventListener('click', () => {
  const field = $('#keyInput');
  field.type = field.type === 'password' ? 'text' : 'password';
  $('#keyToggle').textContent = t(field.type === 'password' ? 'common.show' : 'common.hide');
});
$('#keySave').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const value = $('#keyInput').value.trim();
    if (!value) { toast(t('settings.pasteKey'), 'warn'); return; }
    const result = await put('/api/key', { key: value });
    $('#keyInput').value = '';
    renderKey(result);
    renderReadiness(result.readiness);
    toast(t('settings.keySaved'), 'ok');
  }).catch(showError),
);
$('#keyCheck').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const result = await post('/api/key/check');
    toast(result.ok ? t('settings.keyWorks') : t('settings.keyRejected', { reason: result.reason }), result.ok ? 'ok' : 'error', 7000);
  }).catch(showError),
);
$('#keyRemove').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const result = await put('/api/key', { key: null });
    renderKey(result);
    renderReadiness(result.readiness);
    toast(t('settings.keyRemoved'), 'ok');
  }).catch(showError),
);

$('#previewVoice').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const result = await post('/api/voices/preview', { voice: $('#defaultVoice').value });
    const player = $('#voicePlayer');
    player.hidden = false;
    player.src = mediaUrl(result.path);
    player.play();
  }).catch(showError),
);

$('#clearAllCache').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    const result = await post('/api/cache/clear');
    toast(t('settings.cleared', { count: result.removed }), 'ok');
    await refreshState();
  }).catch(showError),
);

$('#resetSettings').addEventListener('click', () => loadSettings().catch(showError));

$('#saveSettings').addEventListener('click', (event) =>
  withBusy(event.currentTarget, async () => {
    $$('#settingsForm .opt').forEach((opt) => { opt.classList.remove('invalid'); opt.querySelector('.error')?.remove(); });
    try {
      if (state.yamlDirty) {
        await put('/api/config', { text: $('#configText').value });
      } else {
        await put('/api/config/values', { values: state.dirty });
      }
      toast(t('settings.saved'), 'ok');
      await loadSettings();
      await loadReadiness();
      await refreshState();
    } catch (error) {
      // Ошибка называет поле: подсвечиваем его и показываем текст рядом.
      const match = /^\s*([a-z_.]+):\s*(.+)$/m.exec(error.message);
      const field = match && $(`#settingsForm [data-key="${match[1]}"]`);
      if (field) {
        const opt = field.closest('.opt');
        opt.classList.add('invalid');
        opt.querySelector('.opt-text').insertAdjacentHTML('beforeend', `<div class="error">${escapeHtml(match[2])}</div>`);
        showSettingsGroup(opt.closest('fieldset').dataset.group);
      }
      throw error;
    }
  }).catch(showError),
);

// --- окружение -------------------------------------------------------------

async function loadEnvironment() {
  $('#envList').innerHTML = `<div class="notice">${t('env.checking')}</div>`;
  const [readiness, env] = await Promise.all([api('/api/readiness'), api('/api/environment')]);
  renderReadiness(readiness);

  const items = readiness.items.map((item) => `
    <div class="card row-card">
      <div class="grow">
        <div class="name">${escapeHtml(item.title)}</div>
        <div class="meta">${escapeHtml(item.detail)}${item.blocks && item.state !== 'ok' ? ` — ${escapeHtml(item.blocks)}` : ''}</div>
        ${item.hint && item.state !== 'ok' ? `<div class="meta">${escapeHtml(item.hint)}</div>` : ''}
      </div>
      ${item.size ? `<span class="meta">${escapeHtml(item.size)}</span>` : ''}
      <span class="pill ${item.state === 'ok' ? 'ok' : item.state === 'warn' ? 'warn' : 'bad'}">${item.state === 'ok' ? 'готово' : item.state === 'warn' ? 'можно без него' : 'нужно'}</span>
    </div>`);

  const tools = env.tools.filter((tool) => tool.path).map((tool) => `<div class="card row-card"><div class="grow"><div class="name">${tool.name}</div><div class="meta mono">${escapeHtml(tool.path)}</div></div><span class="pill ok">${tool.source === 'local' ? 'в служебном каталоге' : 'в системе'}</span></div>`);

  $('#envList').innerHTML = items.join('') + `<h2>${t('env.toolsTitle')}</h2>` + (tools.join('') || `<div class="notice">${t('env.noTools')}</div>`);
}

$('#refreshEnv').addEventListener('click', (event) => withBusy(event.currentTarget, loadEnvironment).catch(showError));
$('#fetchTools').addEventListener('click', (event) => startProvisioning(event.currentTarget).catch(showError));

// --- состояние и поток событий --------------------------------------------

function safeStorageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
$('#legalOk').addEventListener('click', () => {
  state.legalAccepted = true;
  try { localStorage.setItem('dubpipe-legal-accepted', '1'); } catch { /* сеанс помнит и так */ }
  $('#legal').hidden = true;
});

async function refreshState() {
  const data = await api('/api/state');
  state.projects = data.projects;
  state.stages = data.stages;
  state.languages = data.languages ?? state.languages;
  state.job = data.job;
  state.workingDir = data.workingDir ?? state.workingDir;
  $('#version').textContent = `v${data.version}`;
  $('#profileNote').textContent = t(data.profile === 'offline' ? 'profile.local' : 'profile.cloud');
  $('#legalText').textContent = data.legalNotice;
  fillStageSelects();
  renderProjects();
  renderJob();
  if (!state.legalAccepted && !safeStorageGet('dubpipe-legal-accepted')) $('#legal').hidden = false;
}

/*
 * Таблица реплик заполняется по ходу прогона, а не в конце.
 *
 * Стадии пишут `segments.json` по мере работы: распознавание — реплики с
 * таймкодами и оригиналом, перевод — после каждого пакета, синтез и укладка —
 * длительности и клипы. Ждать конца всего прогона, чтобы показать хоть что-то,
 * незачем: на получасовом фильме это двадцать минут пустого экрана.
 */
const FILLING_STAGES = new Set(['s2', 's3', 's5', 's6']);
const filled = { job: null, stages: new Set(), at: 0 };

function fillSegmentsDuringRun(job) {
  if (!job || job.input !== state.project) return;
  if (filled.job !== job.id) {
    filled.job = job.id;
    filled.stages = new Set();
    filled.at = 0;
  }

  let due = false;
  for (const stage of job.stages ?? []) {
    if (stage.state === 'done' && FILLING_STAGES.has(stage.id) && !filled.stages.has(stage.id)) {
      filled.stages.add(stage.id);
      due = true;
    }
  }
  // Перевод пишет реплики после каждого пакета — показываем их по мере
  // появления, но не чаще раза в две секунды: пакет бывает и по три секунды.
  const translating = (job.stages ?? []).find((stage) => stage.id === 's3' && stage.state === 'running');
  if (translating?.progress?.done && Date.now() - filled.at > 2000) due = true;
  if (!due) return;

  // Правка в таблице важнее обновления: перерисовка увела бы курсор из поля.
  if (document.activeElement?.closest?.('#segmentsTable')) return;
  filled.at = Date.now();
  loadSegments().catch(() => {});
}

function connectEvents() {
  const source = new EventSource(`/api/events?token=${TOKEN}`);
  source.addEventListener('hello', (event) => {
    const data = JSON.parse(event.data);
    state.job = data.job;
    renderJob();
    fillSegmentsDuringRun(state.job);
    for (const record of data.history) appendLog(record);
    for (const item of data.progress ?? []) state.progress.set(item.id, item);
    renderProgress();
  });
  source.addEventListener('log', (event) => appendLog(JSON.parse(event.data)));
  source.addEventListener('progress', (event) => applyProgress(JSON.parse(event.data)));
  source.addEventListener('readiness', (event) => renderReadiness(JSON.parse(event.data)));
  source.addEventListener('job', (event) => {
    const previous = state.job?.status;
    state.job = JSON.parse(event.data);
    renderJob();
    fillSegmentsDuringRun(state.job);
    if (state.job.status !== 'running' && previous === 'running') {
      toast(state.job.status === 'done' ? t('job.finishedOk') : t('job.finishedOther', { status: state.job.status }), state.job.status === 'done' ? 'ok' : 'error', 8000);
      refreshState().catch(() => {});
      loadLibrary().catch(() => {});
      if (state.project === state.job.input) {
        loadSegments().catch(() => {});
        if (state.job.mode === 'subtitles') loadSubtitles().catch(() => {});
      }
    }
  });
  source.onerror = () => setTimeout(connectEvents, 3000);
}

// --- язык интерфейса -------------------------------------------------------

/** Всё, что рисуется кодом, а не разметкой, нужно перерисовать после смены языка. */
function rerenderAll() {
  window.i18n.applyTranslations();
  renderDeviceOptions();
  fillStageSelects();
  renderSegments();
  renderJob();
  renderOutPlace();
  if (subs.data) renderSubtitles();
  loadReadiness().catch(() => {});
  loadLibrary().catch(() => {});
  refreshState().catch(() => {});
}

$('#uiLang').value = window.i18n.language();
// Меню окна живёт в приложении, а не на странице: сообщаем ему язык при старте
// и при каждом переключении.
window.dubpipeNative?.setLanguage?.(window.i18n.language());
$('#uiLang').addEventListener('change', (event) => {
  if (!window.i18n.setLanguage(event.target.value)) return;
  window.dubpipeNative?.setLanguage?.(event.target.value);
  rerenderAll();
});

// --- запуск ----------------------------------------------------------------

window.i18n.applyTranslations();
renderSegments();
renderJob();
connectEvents();
loadDevices().catch(() => {});
refreshState().catch(showError);
loadReadiness().catch(showError);
loadLibrary().catch(showError);
loadCatalog().catch(() => {});
