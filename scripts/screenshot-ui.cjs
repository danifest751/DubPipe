/**
 * Снимки интерфейса для визуальной проверки.
 *
 * Коды ответов HTTP не доказывают, что страница выглядит как надо. Скрипт
 * поднимает сервер, грузит страницу в настоящем окне и сохраняет снимки всех
 * экранов в scripts/screens/: библиотека, проект, все группы настроек,
 * окружение и обозреватель папок.
 *
 * Запуск: npx electron scripts/screenshot-ui.cjs
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
  const problems = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) problems.push(message);
  });

  await window.loadURL(server.url);
  await sleep(2500);

  const run = (script) => window.webContents.executeJavaScript(script);
  const dismissLegal = () => run(`(() => { const b = document.getElementById('legalOk'); if (b && !document.getElementById('legal').hidden) b.click(); return true; })()`);
  const shot = async (name, wait = 1200) => {
    await sleep(wait);
    await dismissLegal();
    await sleep(150);
    fs.writeFileSync(path.join(outDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    console.log(`снимок сохранён: ${name}.png`);
  };

  const checks = await run(`(() => ({
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    fontFamily: getComputedStyle(document.body).fontFamily,
    activeView: document.querySelector('.view.active')?.dataset.view ?? null,
    hiddenViews: Array.from(document.querySelectorAll('.view')).filter((v) => getComputedStyle(v).display === 'none').length,
    totalViews: document.querySelectorAll('.view').length,
    nav: Array.from(document.querySelectorAll('#nav button')).map((b) => b.textContent.trim()),
  }))()`);
  console.log('проверки отрисовки:', JSON.stringify(checks, null, 2));

  await shot('library');

  // Страница проекта: открываем первый файл из библиотеки или из истории.
  await run(`(() => { const b = document.querySelector('[data-open]'); if (b) b.click(); return Boolean(b); })()`);
  await shot('project', 2000);
  await run(`document.querySelector('#subtabs button[data-sub="compare"]').click()`);
  await shot('project-compare', 800);

  // Настройки — каждая группа отдельно.
  await run(`document.querySelector('#nav button[data-view="settings"]').click()`);
  await sleep(1500);
  for (const group of ['translate', 'voice', 'asr', 'audio', 'fit', 'system', 'yaml']) {
    await run(`document.querySelector('#settingsNav button[data-group="${group}"]').click()`);
    await shot(`settings-${group}`, 400);
  }

  await run(`document.querySelector('#nav button[data-view="environment"]').click()`);
  await shot('environment', 3500);

  // Обозреватель папок виден только в браузере — в окне приложения его заменяет
  // системный диалог, поэтому снимаем принудительно.
  await run(`document.querySelector('#nav button[data-view="library"]').click(); openBrowser('folder'); true`);
  await shot('browser', 1500);

  if (problems.length) console.log('ошибки в консоли страницы:', problems);
  await server.close();
  app.quit();
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('ошибка:', error);
    app.exit(1);
  }),
);
