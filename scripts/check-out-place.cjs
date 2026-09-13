/**
 * Проверка выбора места для итога: переключатель «рядом с исходным / в другую
 * папку», превью пути и то, что задача уходит с выбранной папкой, а не с ручным
 * путём. Ничего не обрабатывает — только смотрит на страницу.
 *
 * Запуск: DUBPIPE_HOME=<каталог с config.yaml> npx electron scripts/check-out-place.cjs
 * Снимок: scripts/screens/project-out-place.png
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

  const window = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { contextIsolation: true } });
  const run = (code) => window.webContents.executeJavaScript(code, true);
  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  for (let i = 0; i < 10; i++) {
    if (await run(`(() => { const box = document.getElementById('legal'); if (box && !box.hidden) { document.getElementById('legalOk').click(); return true; } return false; })()`)) break;
    await sleep(300);
  }

  // Пустая строка совпадает с любым названием — берётся первый проект библиотеки.
  const needle = process.env.DUBPIPE_PROJECT ?? '';
  const opened = await run(`(() => { const b = [...document.querySelectorAll('[data-open]')].find((el) => el.closest('.file, .card, tr, li, div')?.textContent.includes(${JSON.stringify(needle)})); if (b) b.click(); return Boolean(b); })()`);
  if (!opened) throw new Error(needle ? `в библиотеке нет проекта с «${needle}»` : 'библиотека пуста: выберите папку с видео в приложении');
  await sleep(1500);
  await run(`document.getElementById('toggleAdvanced').click()`);
  await sleep(400);

  const beside = await run(`({ preview: document.getElementById('outPreview').textContent, folderRowHidden: document.getElementById('outFolderRow').hidden })`);

  // Переключаем на «в другую папку» и подставляем путь так же, как это делает диалог.
  await run(`(() => { const r = [...document.querySelectorAll('input[name=outMode]')].find((x) => x.value === 'folder'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
  await sleep(200);
  const emptyFolder = await run(`({ preview: document.getElementById('outPreview').textContent, folderRowHidden: document.getElementById('outFolderRow').hidden })`);
  await run(`(() => { window.state = window.state; })()`);
  // Моста Electron в этом окне нет, поэтому «Обзор» открывает встроенный
  // обозреватель папок — им и выбираем папку, как это делает пользователь.
  await run(`document.getElementById('pickOutDir').click()`);
  for (let i = 0; i < 20 && (await run(`document.getElementById('browser').hidden`)); i++) await sleep(200);
  const browserPath = await run(`document.getElementById('browserPath').textContent`);
  await run(`document.getElementById('browserChoose').click()`);
  await sleep(500);
  const chosen = await run(`({ preview: document.getElementById('outPreview').textContent, value: document.getElementById('outDir').value })`);
  const sent = await run(`(() => {
    // Что уйдёт на сервер при запуске: подменяем сеть и жмём «Дублировать».
    const original = window.fetch;
    let captured = null;
    window.fetch = (url, init) => {
      if (String(url).includes('/api/jobs')) { captured = JSON.parse(init.body); return Promise.resolve(new Response('{}', { status: 202 })); }
      return original(url, init);
    };
    document.getElementById('startJob').click();
    return new Promise((resolve) => setTimeout(() => { window.fetch = original; resolve(captured); }, 400));
  })()`);
  await sleep(400);
  fs.writeFileSync(path.join(outDir, 'project-out-place.png'), (await window.webContents.capturePage()).toPNG());

  console.log(JSON.stringify({ beside, emptyFolder, browserPath, chosen, sent }, null, 1));
  const ok =
    beside.folderRowHidden === true &&
    /^Файл: .+\.ru\.mp4$/.test(beside.preview) &&
    emptyFolder.folderRowHidden === false &&
    /Выберите папку/.test(emptyFolder.preview) &&
    chosen.value === browserPath &&
    chosen.preview.includes(browserPath) &&
    /\.ru\.mp4$/.test(chosen.preview) &&
    Boolean(sent) &&
    sent.outDir === browserPath;
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
