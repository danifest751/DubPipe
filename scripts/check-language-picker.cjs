/**
 * Проверка выбора языка оригинала в настройках: список заполнен профилями,
 * выбор сохраняется и попадает в конфигурацию.
 *
 * Запуск: npx electron scripts/check-language-picker.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const core = pathToFileURL(path.join(__dirname, '..', 'dist', 'ui', 'server.js')).href;
  const { startUiServer } = await import(core);
  const server = await startUiServer({});
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true } });
  const run = (code) => window.webContents.executeJavaScript(code, true);

  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  for (let i = 0; i < 10; i++) {
    if (await run(`(() => { const box = document.getElementById('legal'); if (box && !box.hidden) { document.getElementById('legalOk').click(); return true; } return false; })()`)) break;
    await sleep(300);
  }
  await run(`document.querySelector('#nav button[data-view="settings"]').click()`);
  for (let i = 0; i < 20 && !(await run(`document.querySelectorAll('#sourceLanguage option').length > 0`)); i++) await sleep(300);

  const list = await run(`({
    count: document.querySelectorAll('#sourceLanguage option').length,
    current: document.getElementById('sourceLanguage').value,
    hasKorean: [...document.querySelectorAll('#sourceLanguage option')].some((o) => o.value === 'ko'),
    koreanLabel: [...document.querySelectorAll('#sourceLanguage option')].find((o) => o.value === 'ko')?.textContent ?? '',
  })`);

  // Выбор корейского помечает настройки изменёнными и уходит на сервер как asr.language.
  const sent = await run(`(async () => {
    const select = document.getElementById('sourceLanguage');
    select.value = 'ko';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 200));
    const original = window.fetch;
    let captured = null;
    window.fetch = (url, init) => {
      if (String(url).includes('/api/config/values')) { captured = JSON.parse(init.body); }
      return original(url, init);
    };
    document.getElementById('saveSettings').click();
    await new Promise((r) => setTimeout(r, 1200));
    window.fetch = original;
    return captured;
  })()`);

  const applied = await (await fetch(`${new URL(server.url).origin}/api/config?token=${server.token}`)).json();
  console.log(JSON.stringify({ list, sent, appliedLanguage: applied.parsed?.asr?.language }, null, 1));
  const ok = list.count > 5 && list.hasKorean && /корейский|Korean/.test(list.koreanLabel) && sent?.values?.['asr.language'] === 'ko' && applied.parsed?.asr?.language === 'ko';
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
