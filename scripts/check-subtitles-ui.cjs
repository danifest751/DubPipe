/**
 * Проверка вкладки «Субтитры»: титры видны, замечания посчитаны, правка текста
 * и времени принимается, переключение языков работает, предпросмотр показывает
 * титр по времени видео. Ничего не пересчитывает.
 *
 * Запуск: DUBPIPE_HOME=<каталог с config.yaml> npx electron scripts/check-subtitles-ui.cjs
 * Снимок: scripts/screens/project-subtitles.png
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const outDir = path.join(__dirname, 'screens');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (process.env.DUBPIPE_HOME) process.chdir(process.env.DUBPIPE_HOME);
  const core = pathToFileURL(path.join(__dirname, '..', 'dist', 'ui', 'server.js')).href;
  const { startUiServer } = await import(core);
  const server = await startUiServer({});
  fs.mkdirSync(outDir, { recursive: true });

  const window = new BrowserWindow({ width: 1500, height: 1000, show: true, webPreferences: { contextIsolation: true } });
  const run = (code) => window.webContents.executeJavaScript(code, true);
  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  for (let i = 0; i < 10; i++) {
    if (await run(`(() => { const box = document.getElementById('legal'); if (box && !box.hidden) { document.getElementById('legalOk').click(); return true; } return false; })()`)) break;
    await sleep(300);
  }

  // Пустая строка совпадает с любым названием — берётся первый проект библиотеки.
  const needle = process.env.DUBPIPE_PROJECT ?? '';
  const hasButton = await run(`Boolean([...document.querySelectorAll('[data-subs]')].find((el) => el.dataset.subs.includes(${JSON.stringify(needle)})))`);
  // Кнопка «Субтитры» в библиотеке: перехватываем запрос, ничего не запуская.
  const libraryRequest = await run(`(async () => {
    const original = window.fetch;
    let captured = null;
    window.fetch = (url, init) => {
      if (String(url).includes('/api/jobs')) { captured = JSON.parse(init.body); return Promise.resolve(new Response(JSON.stringify({ id: 'test', input: '', status: 'running', mode: 'subtitles', stages: [], warnings: [] }), { status: 202 })); }
      return original(url, init);
    };
    const button = [...document.querySelectorAll('[data-subs]')].find((el) => el.dataset.subs.includes(${JSON.stringify(needle)}));
    if (!button) return { error: 'кнопки нет' };
    button.click();
    await new Promise((r) => setTimeout(r, 4000));
    window.fetch = original;
    return captured;
  })()`);
  await sleep(600);

  const opened = await run(`(() => { const b = [...document.querySelectorAll('[data-open]')].find((el) => el.closest('.file, .card, tr, li, div')?.textContent.includes(${JSON.stringify(needle)})); if (b) b.click(); return Boolean(b); })()`);
  if (!opened) throw new Error(needle ? `в библиотеке нет проекта с «${needle}»` : 'библиотека пуста: выберите папку с видео в приложении');
  await sleep(1200);
  await run(`document.querySelector('#subtabs button[data-sub="subtitles"]').click()`);
  for (let i = 0; i < 20 && !(await run(`document.querySelectorAll('#subsTable tbody tr').length > 1`)); i++) await sleep(300);

  const sourceLabel = await run(`document.getElementById('subSourceLabel').textContent`);
  const en = await run(`({
    rows: document.querySelectorAll('#subsTable tbody tr').length,
    summary: document.getElementById('subsSummary').textContent,
    file: document.getElementById('subsFile').textContent,
    firstText: document.querySelector('#subsTable tbody textarea')?.value ?? '',
    previewShown: !document.getElementById('subsPreview').hidden,
  })`);

  // Предпросмотр: перематываем на первый титр и смотрим наложенный текст.
  await run(`(() => { const v = document.getElementById('subsVideo'); v.currentTime = 15; v.dispatchEvent(new Event('timeupdate')); })()`);
  await sleep(300);
  const overlay = await run(`document.getElementById('subsOverlayText').textContent`);

  // Правка времени в неверном формате не должна ломать таблицу.
  await run(`(() => { const input = document.querySelector('#subsTable tbody input[data-cue-field="end"]'); input.value = 'абв'; input.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const afterBadEdit = await run(`document.querySelectorAll('#subsTable tbody tr').length`);

  // Правка текста помечает несохранённые изменения.
  await run(`(() => { const area = document.querySelector('#subsTable tbody textarea'); area.value = 'Правленый титр'; area.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const afterEdit = await run(`({ summary: document.getElementById('subsSummary').textContent, first: document.querySelector('#subsTable tbody textarea').value })`);

  fs.writeFileSync(path.join(outDir, 'project-subtitles.png'), (await window.webContents.capturePage()).toPNG());

  // Переключение на русские титры (правки сбрасываем подтверждением).
  await run(`(() => { window.confirm = () => true; })()`);
  await run(`(() => { const r = [...document.querySelectorAll('input[name=subKind]')].find((x) => x.value === 'target'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  const target = await run(`({ rows: document.querySelectorAll('#subsTable tbody tr').length, file: document.getElementById('subsFile').textContent, firstText: document.querySelector('#subsTable tbody textarea')?.value ?? '' })`);

  console.log(JSON.stringify({ hasButton, libraryRequest, sourceLabel, en, overlay, afterBadEdit, afterEdit, target }, null, 1));
  const ok =
    hasButton &&
    Boolean(libraryRequest) &&
    libraryRequest.mode === 'subtitles' &&
    String(libraryRequest.input).includes('.mp4') &&
    en.rows > 10 &&
    /титров/.test(en.summary) &&
    /\.en\.srt/.test(en.file) &&
    en.previewShown &&
    overlay.length > 0 &&
    afterBadEdit === en.rows &&
    /несохранённые правки/.test(afterEdit.summary) &&
    afterEdit.first === 'Правленый титр' &&
    target.rows > 10 &&
    /\.ru\.srt/.test(target.file) &&
    /[а-яё]/i.test(target.firstText) &&
    /Оригинал \(/.test(sourceLabel);
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
