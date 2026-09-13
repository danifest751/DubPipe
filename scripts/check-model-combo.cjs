/**
 * Проверка поля выбора модели в настройках: набираем текст и смотрим,
 * что список раскрылся, совпадения подсвечены, Enter выбирает.
 *
 * Запуск: npx electron scripts/check-model-combo.cjs
 * Снимок: scripts/screens/settings-model-combo.png
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

  const window = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { contextIsolation: true } });
  const run = (code) => window.webContents.executeJavaScript(code, true);
  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  await run(`(() => { const b = document.getElementById('legalOk'); if (b && !document.getElementById('legal').hidden) b.click(); })()`);
  await run(`document.querySelector('#nav button[data-view="settings"]').click()`);
  await sleep(1200);

  // Набираем «claude 4» по буквам — как пользователь.
  await run(`(() => { const f = document.getElementById('settingsModel'); f.value = ''; f.focus(); })()`);
  for (const char of 'claude 4') {
    await run(`(() => { const f = document.getElementById('settingsModel'); f.value += ${JSON.stringify(char)}; f.dispatchEvent(new Event('input')); })()`);
    await sleep(40);
  }
  await sleep(300);
  const report = await run(`(() => {
    const list = document.getElementById('settingsModelList');
    const items = [...list.querySelectorAll('.combo-item')];
    return {
      open: !list.hidden,
      count: items.length,
      marks: list.querySelectorAll('mark').length,
      first: items[0]?.querySelector('.id')?.textContent ?? null,
      active: list.querySelector('.combo-item.active')?.querySelector('.id')?.textContent ?? null,
      note: document.getElementById('settingsModelNote').textContent,
    };
  })()`);
  fs.writeFileSync(path.join(outDir, 'settings-model-combo.png'), (await window.webContents.capturePage()).toPNG());

  // Стрелка вниз + Enter выбирают вторую модель и помечают форму изменённой.
  await run(`(() => { const f = document.getElementById('settingsModel'); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await sleep(200);
  const chosen = await run(`({ value: document.getElementById('settingsModel').value, closed: document.getElementById('settingsModelList').hidden, dirty: !document.getElementById('savebar').hidden })`);

  console.log(JSON.stringify({ typed: report, chosen }, null, 1));
  const ok = report.open && report.count > 0 && report.marks > 0 && chosen.closed && chosen.dirty && chosen.value.includes('claude');
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
