/**
 * Проверка переключателя языка: подписи меняются, выбор сохраняется между
 * запусками, ключей без перевода на экране не остаётся.
 *
 * Запуск: npx electron scripts/check-i18n.cjs
 * Снимки: scripts/screens/ui-ru.png, scripts/screens/ui-en.png
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

  const snapshot = () => run(`({
    lang: document.documentElement.lang,
    nav: [...document.querySelectorAll('#nav button')].map((b) => b.textContent.trim()),
    tabs: [...document.querySelectorAll('#subtabs button')].map((b) => b.textContent.trim()),
    dub: document.getElementById('startJob').textContent.trim(),
    switcher: document.getElementById('uiLang').value,
  })`);

  await run(`(() => { const s = document.getElementById('uiLang'); s.value = 'ru'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  const ru = await snapshot();
  fs.writeFileSync(path.join(outDir, 'ui-ru.png'), (await window.webContents.capturePage()).toPNG());

  await run(`(() => { const s = document.getElementById('uiLang'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  const en = await snapshot();
  fs.writeFileSync(path.join(outDir, 'ui-en.png'), (await window.webContents.capturePage()).toPNG());

  // Выбор языка должен пережить перезагрузку страницы.
  await window.reload();
  await sleep(1800);
  const afterReload = await snapshot();

  // Непереведённые ключи видно сразу: они выглядят как «library.dub».
  // Непереведённый ключ выглядит как «library.dub»: точки есть, пробелов нет.
  // Регулярные выражения здесь не используются — экранирование при передаче
  // кода в окно съедает обратные слэши и превращает точку в «любой символ».
  const leftovers = await run(`[...document.querySelectorAll('body *')]
    .map((el) => (el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.textContent.trim() : ''))
    .filter((text) => text.includes('.') && !text.includes(' ') && !text.includes('/') && !text.includes(String.fromCharCode(92)))
    .filter((text) => text.split('.').every((part) => part.length > 0 && /^[a-zA-Z][a-zA-Z0-9]*$/.test(part)))
    .filter((text) => !['mp4','mkv','avi','mov','webm','m4a','mp3','wav','srt','json','yaml','yml','log','exe','onnx','bin'].includes(text.split('.').pop().toLowerCase()))
    .slice(0, 5)`);

  /*
   * Второй род пропусков: не непереведённый ключ, а русский текст, зашитый в
   * разметку без ключа вовсе. Проверка выше его не видит — он выглядит как
   * обычная фраза, — и экран настроек месяцами оставался русским на английском
   * интерфейсе, пока проверка печатала «ПРОЙДЕНА».
   *
   * Смотрим настройки: там таких пояснений больше всего. Группа YAML исключена
   * намеренно — в ней показан config.yaml пользователя с русскими комментариями,
   * и это не перевод, а содержимое файла.
   */
  await run(`(() => { const s = document.getElementById('uiLang'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  await run(`(() => { const b = [...document.querySelectorAll('#nav button')].find((n) => n.textContent.trim() === 'Settings'); if (b) b.click(); })()`);
  await sleep(400);

  const cyrillic = [];
  const groups = await run(`[...document.querySelectorAll('#settingsNav button[data-group]')].map((b) => b.dataset.group)`);
  for (const group of [...new Set(groups)].filter((g) => g !== 'yaml')) {
    await run(
      `(() => { const b = [...document.querySelectorAll('#settingsNav button[data-group]')]` +
        `.find((n) => n.dataset.group === ${JSON.stringify(group)}); if (b) b.click(); return Boolean(b); })()`,
    );
    await sleep(250);
    const found = await run(`(() => {
      const out = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const text = n.textContent.trim();
        if (!text) continue;
        let hasCyrillic = false;
        for (const ch of text) { const c = ch.charCodeAt(0); if (c >= 0x400 && c <= 0x4ff) { hasCyrillic = true; break; } }
        if (!hasCyrillic) continue;
        const el = n.parentElement;
        if (!el || el.offsetParent === null) continue;
        out.push(text.slice(0, 80));
      }
      return out;
    })()`);
    for (const text of found) if (!cyrillic.includes(text)) cyrillic.push(text);
  }

  console.log(JSON.stringify({ ru, en, afterReload, leftovers, cyrillic }, null, 1));
  const ok =
    ru.lang === 'ru' &&
    en.lang === 'en' &&
    ru.nav.join() !== en.nav.join() &&
    en.nav.includes('Videos') &&
    en.tabs.includes('Subtitles') &&
    en.dub === 'Dub' &&
    afterReload.switcher === 'en' &&
    afterReload.nav.includes('Videos') &&
    leftovers.length === 0 &&
    cyrillic.length === 0;
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
