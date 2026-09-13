/**
 * Проверка обратной связи при загрузке компонентов.
 *
 * Ровно тот сценарий, который выглядел зависшим: нажатие «Догрузить недостающее».
 * Скрипт временно убирает yt-dlp, нажимает кнопку в настоящем окне и снимает
 * экран во время загрузки — видно ли, что происходит.
 *
 * Запуск: npx electron scripts/check-progress.cjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const outDir = path.join(__dirname, 'screens');
const ytDlpDir = path.join(root, '.dubpipe', 'tools', 'yt-dlp');
const stash = path.join(root, '.dubpipe', 'tools', '.yt-dlp-stash');

async function main() {
  // Прячем компонент, чтобы кнопке было что загружать.
  const hidden = fs.existsSync(ytDlpDir);
  if (hidden) fs.renameSync(ytDlpDir, stash);

  try {
    const core = pathToFileURL(path.join(root, 'dist', 'ui', 'server.js')).href;
    const { startUiServer } = await import(core);
    const server = await startUiServer({});

    const window = new BrowserWindow({ width: 1400, height: 900, show: false });
    await window.loadURL(server.url);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    await window.webContents.executeJavaScript(
      `(() => { const b = document.getElementById('legalOk'); if (b) b.click(); return true; })()`,
    );

    const before = await window.webContents.executeJavaScript(
      `document.getElementById('readinessSummary').textContent`,
    );
    console.log('готовность до загрузки:', before);

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'readiness-missing.png'), (await window.webContents.capturePage()).toPNG());
    console.log('снимок сохранён: readiness-missing.png');

    // Нажимаем ту самую кнопку.
    await window.webContents.executeJavaScript(`document.getElementById('fetchTools').click(); true`);

    for (const delay of [1200, 1800, 2500]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const visible = await window.webContents.executeJavaScript(`(() => {
        const items = Array.from(document.querySelectorAll('.progress-item'));
        return items.map((item) => item.querySelector('.line').textContent.replace(/\\s+/g, ' ').trim());
      })()`);
      console.log('видно на экране:', visible.length ? visible : '(полос нет)');
      if (visible.length) {
        fs.writeFileSync(path.join(outDir, 'progress.png'), (await window.webContents.capturePage()).toPNG());
        console.log('снимок сохранён: progress.png');
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 9000));
    const after = await window.webContents.executeJavaScript(
      `document.getElementById('readinessSummary').textContent`,
    );
    console.log('готовность после загрузки:', after);

    await server.close();
  } finally {
    if (fs.existsSync(stash) && !fs.existsSync(ytDlpDir)) fs.renameSync(stash, ytDlpDir);
    else if (fs.existsSync(stash)) fs.rmSync(stash, { recursive: true, force: true });
  }

  app.quit();
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('ошибка:', error);
    app.exit(1);
  }),
);
