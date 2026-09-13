/**
 * Проверка кнопки «Проверить» у поля модели: рабочая модель даёт зелёный вердикт
 * с тремя переводами, несуществующая — красный с причиной. Нужен ключ шлюза.
 *
 * Запуск: npx electron scripts/check-model-check.cjs
 * Снимок: scripts/screens/settings-model-check.png
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

  const check = async (model) => {
    await run(`(() => { const f = document.getElementById('settingsModel'); f.value = ${JSON.stringify(model)}; document.getElementById('settingsModelCheckResult').hidden = true; document.getElementById('settingsModelCheck').click(); })()`);
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const state = await run(`(() => { const box = document.getElementById('settingsModelCheckResult'); if (box.hidden) return null; return { head: box.querySelector('.head')?.textContent.trim() ?? '', ok: Boolean(box.querySelector('.head.ok')), lines: [...box.querySelectorAll('.line .ru')].map((e) => e.textContent) }; })()`);
      if (state) return state;
    }
    return null;
  };

  const good = await check('anthropic/claude-haiku-4.5');
  await sleep(400); // кадр скрытого окна перерисовывается не сразу
  fs.writeFileSync(path.join(outDir, 'settings-model-check.png'), (await window.webContents.capturePage()).toPNG());
  const bad = await check('nobody/no-such-model-xyz');

  console.log(JSON.stringify({ good, bad }, null, 1));
  const ok = Boolean(good && good.ok && good.lines.length === 3 && good.lines.every((line) => /[а-яё]/i.test(line))) && Boolean(bad && !bad.ok);
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
