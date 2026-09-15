/**
 * Проверка выбора движка синтеза в настройках.
 *
 * Движок был доступен только правкой config.yaml руками, а подпись под выбором
 * голоса всегда называла piper. Проверяется на живом приложении: селектор есть,
 * смена движка подменяет список голосов на его собственный и меняет пояснение.
 *
 * Запуск: npx electron scripts/check-tts-engine.cjs
 * Снимок: scripts/screens/settings-tts-engine.png
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
    if (await run(`(() => { const box = document.getElementById('legal'); if (box && !box.hidden) { document.getElementById('legalOk').click(); return true; } return false; })()`)) break;
    await sleep(300);
  }

  await run(`(() => { const b = [...document.querySelectorAll('#nav button')].find((n) => n.dataset.view === 'settings'); if (b) b.click(); })()`);
  await sleep(400);
  await run(`(() => { const b = [...document.querySelectorAll('#settingsNav button[data-group]')].find((n) => n.dataset.group === 'voice'); if (b) b.click(); })()`);
  await sleep(400);

  const snapshot = () =>
    run(`(() => {
      const note = document.getElementById('defaultVoice').closest('.opt').querySelector('.opt-text span');
      return {
        engine: document.getElementById('ttsEngine') ? document.getElementById('ttsEngine').value : null,
        voices: [...document.getElementById('defaultVoice').options].map((o) => o.value),
        chosen: document.getElementById('defaultVoice').value,
        noteKey: note ? note.dataset.i18n : null,
      };
    })()`);

  // Настройки подтягиваются запросом: до их прихода список голосов пуст, и
  // снимок «до» показывал бы не состояние формы, а её незаполненность.
  for (let i = 0; i < 40; i++) {
    const ready = await run(`document.getElementById('defaultVoice').options.length > 0`);
    if (ready) break;
    await sleep(250);
  }

  const before = await snapshot();
  await run(`(() => { const s = document.getElementById('ttsEngine'); s.value = 'silero'; s.dispatchEvent(new Event('change')); })()`);
  // Ждём смены списка, а не фиксированный срок: запрос к серверу иногда не
  // укладывается в отведённые «на глаз» девятьсот миллисекунд, и проверка
  // краснела на ровном месте.
  for (let i = 0; i < 40; i++) {
    const swapped = await run(`(() => {
      const first = document.getElementById('defaultVoice').options[0];
      return Boolean(first) && !first.value.startsWith('ru_RU-');
    })()`);
    if (swapped) break;
    await sleep(250);
  }
  const after = await snapshot();
  fs.writeFileSync(path.join(outDir, 'settings-tts-engine.png'), (await window.webContents.capturePage()).toPNG());

  console.log(JSON.stringify({ before: { ...before, voices: before.voices.slice(0, 3) }, after: { ...after, voices: after.voices.slice(0, 3) } }, null, 1));

  const ok =
    before.engine === 'piper' &&
    before.voices.every((name) => name.startsWith('ru_RU-')) &&
    before.noteKey === 'settings.defaultVoiceNote.piper' &&
    after.engine === 'silero' &&
    after.voices.length > 20 &&
    after.voices.every((name) => !name.startsWith('ru_RU-')) &&
    after.voices.includes(after.chosen) &&
    after.noteKey === 'settings.defaultVoiceNote.silero';

  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
