/**
 * Проверка локального перевода в настройках.
 *
 * Профиль «офлайн» переключает движок на Ollama, но строка выбора модели была
 * спрятана именно в этом профиле, а `translate.model` оставался именем из
 * каталога шлюза — то есть офлайн из коробки не работал. Проверяется на живом
 * приложении: строка видна, список показывает скачанные локально модели, а не
 * облачные, и подпись под полем меняется вместе с профилем.
 *
 * Нужна запущенная Ollama хотя бы с одной моделью; без неё проверка честно
 * сообщает, что проверять нечего, и не притворяется пройденной.
 *
 * Запуск: npx electron scripts/check-local-models.cjs
 * Снимок: scripts/screens/settings-local-models.png
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const outDir = path.join(__dirname, 'screens');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const core = pathToFileURL(path.join(__dirname, '..', 'dist', 'ui', 'server.js')).href;
  const { startUiServer } = await import(core);
  const server = await startUiServer({});
  fs.mkdirSync(outDir, { recursive: true });

  const window = new BrowserWindow({ width: 1280, height: 860, show: true, webPreferences: { contextIsolation: true } });
  const run = (code) => window.webContents.executeJavaScript(code, true);
  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  for (let i = 0; i < 10; i++) {
    if (await run(`(() => { const b = document.getElementById('legal'); if (b && !b.hidden) { document.getElementById('legalOk').click(); return true; } return false; })()`)) break;
    await sleep(300);
  }

  await run(`(() => { const b = [...document.querySelectorAll('#nav button')].find((n) => n.dataset.view === 'settings'); if (b) b.click(); })()`);
  await sleep(400);
  await run(`(() => { const b = [...document.querySelectorAll('#settingsNav button[data-group]')].find((n) => n.dataset.group === 'translate'); if (b) b.click(); })()`);
  for (let i = 0; i < 40; i++) {
    if (await run(`Array.isArray(state.catalog) && state.catalog.length > 0`)) break;
    await sleep(250);
  }

  const snapshot = () =>
    run(`(() => {
      const row = document.getElementById('settingsModel').closest('.opt');
      return {
        profile: [...document.querySelectorAll('input[name="profile"]')].find((r) => r.checked).value,
        rowHidden: Boolean(row.hidden) || row.offsetParent === null,
        local: Boolean(state.catalogLocal),
        count: state.catalog.length,
        first: state.catalog.slice(0, 3).map((m) => m.id),
        noteKey: row.querySelector('.opt-text span').dataset.i18n,
      };
    })()`);

  const cloud = await snapshot();

  await run(`(() => { const r = [...document.querySelectorAll('input[name="profile"]')].find((x) => x.value === 'offline'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
  // Ждём подмены списка, а не фиксированный срок: за моделями идёт запрос.
  for (let i = 0; i < 40; i++) {
    // Ждём подмены содержимого, а не флага: флаг ставится по ответу, но список
    // проще проверить по самим именам — у локальных моделей нет косой черты.
    const swapped = await run(`state.catalogLocal === true && state.catalog.length > 0 && !state.catalog[0].id.includes('/')`);
    if (swapped) break;
    await sleep(250);
  }
  const local = await snapshot();
  fs.writeFileSync(path.join(outDir, 'settings-local-models.png'), (await window.webContents.capturePage()).toPNG());

  console.log(JSON.stringify({ cloud, local }, null, 1));

  if (local.count === 0) {
    console.log('ПРОВЕРЯТЬ НЕЧЕГО: локальных моделей нет, запустите Ollama и скачайте хотя бы одну');
    await server.close?.();
    app.exit(2);
    return;
  }

  const ok =
    cloud.local === false &&
    cloud.rowHidden === false &&
    local.local === true &&
    local.rowHidden === false &&
    local.noteKey === 'settings.modelNote.local' &&
    // У локальных моделей имена вида `qwen3:8b`, у шлюза — `vendor/model`.
    local.first.every((id) => !id.includes('/'));

  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
