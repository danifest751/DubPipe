/**
 * Проверка настроек «где считать»: три новых поля видны, заполняются из
 * конфигурации, запоминают выбор и переводятся вместе с интерфейсом.
 *
 * Запуск: npx electron scripts/check-compute-settings.cjs
 * Снимок: scripts/screens/compute-settings.png
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

  const window = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: { contextIsolation: true } });
  const run = (code) => window.webContents.executeJavaScript(code, true);
  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  for (let i = 0; i < 10; i++) {
    if (await run(`(() => { const box = document.getElementById('legal'); if (box && !box.hidden) { document.getElementById('legalOk').click(); return true; } return false; })()`)) break;
    await sleep(300);
  }

  // Вкладка настроек, а внутри неё — раздел «Распознавание»: страница настроек
  // разбита на разделы, и поля соседних разделов честно скрыты.
  await run(`[...document.querySelectorAll('#nav button')].find((b) => b.dataset.view === 'settings')?.click()`);
  await sleep(700);
  await run(`document.querySelector('#settingsNav button[data-group="asr"]').click()`);
  await sleep(500);

  // Каждое поле проверяем в своём разделе: соседние разделы честно скрыты.
  const keys = ['asr.backend', 'asr.diarization.device', 'separation.apply', 'separation.device'];
  const fields = [];
  for (const key of keys) {
    const group = await run(`document.querySelector('#settingsForm [data-key="${key}"]')?.closest('fieldset')?.dataset.group ?? null`);
    if (group) {
      await run(`document.querySelector('#settingsNav button[data-group="${group}"]').click()`);
      await sleep(400);
    }
    fields.push(
      await run(`(() => {
        const field = document.querySelector('#settingsForm [data-key="${key}"]');
        if (!field) return { key: '${key}', found: false };
        const box = field.closest('.opt');
        return {
          key: '${key}',
          found: true,
          group: '${group}',
          value: field.value,
          options: [...field.options].map((o) => o.value),
          label: box ? box.querySelector('b').textContent.trim() : '',
          visible: field.offsetParent !== null,
        };
      })()`),
    );
  }

  await run(`document.querySelector('#settingsNav button[data-group="asr"]').click()`);
  await sleep(400);
  fs.writeFileSync(path.join(outDir, 'compute-settings.png'), (await window.webContents.capturePage()).toPNG());

  // Выбор должен отмечаться как несохранённое изменение.
  const dirty = await run(`(() => {
    const field = document.querySelector('#settingsForm [data-key="separation.device"]');
    field.value = 'cpu';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return !document.getElementById('savebar').hidden;
  })()`);

  // Подписи должны меняться вместе с языком интерфейса.
  await run(`(() => { const s = document.getElementById('uiLang'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  const english = await run(`document.querySelector('#settingsForm [data-key="asr.backend"]').closest('.opt').querySelector('b').textContent.trim()`);

  console.log(JSON.stringify({ fields, dirty, english }, null, 1));
  const ok =
    fields.every((f) => f.found && f.visible && f.options.length >= 2 && f.label.length > 0) &&
    fields[0].options.includes('vulkan') &&
    fields[1].options.includes('igpu') &&
    fields[2].options.includes('under_speech') &&
    dirty === true &&
    /[A-Za-z]/.test(english) &&
    !/[А-Яа-я]/.test(english);
  console.log(ok ? 'ОК: настройки «где считать» на месте' : 'ПРОВАЛ');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
