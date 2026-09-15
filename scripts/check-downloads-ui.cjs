/**
 * Проверка вкладки «Загрузки»: ссылка разбирается до загрузки, карточка
 * показывает название и размер, загрузка ставится, прогресс виден, отмена
 * работает.
 *
 * Сеть здесь неизбежна (разбор ссылки — обращение к YouTube), поэтому скрипт
 * живёт в scripts/, а не в тестах. Запуск:
 *
 *   npm run build && npx electron scripts/check-downloads-ui.cjs
 *
 * Снимки: scripts/screens/downloads-resolve.png, downloads-job.png
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LINK = process.argv[2] ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const outDir = path.join(__dirname, 'screens');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const core = pathToFileURL(path.join(__dirname, '..', 'dist', 'ui', 'server.js')).href;
  const { startUiServer } = await import(core);
  const server = await startUiServer({});
  fs.mkdirSync(outDir, { recursive: true });

  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { contextIsolation: true },
  });
  const run = (code) => window.webContents.executeJavaScript(code, true);
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    // Предупреждение Electron о CSP — про среду запуска, а не про страницу: в
    // собранном приложении его нет. За свой код отвечаем здесь, за политику
    // безопасности — отдельно.
    if (level >= 2 && !/Electron Security Warning|Content-Security-Policy/i.test(message)) {
      errors.push(message);
    }
  });

  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  for (let i = 0; i < 10; i++) {
    const closed = await run(`(() => {
      const box = document.getElementById('legal');
      if (box && !box.hidden) { document.getElementById('legalOk').click(); return true; }
      return false;
    })()`);
    if (closed) break;
    await sleep(300);
  }

  console.log('1. Вкладка «Загрузки»');
  await run(`document.querySelector('#nav button[data-view="downloads"]').click()`);
  await sleep(600);
  const view = await run(`({
    active: document.querySelector('section[data-view="downloads"]').classList.contains('active'),
    title: document.querySelector('section[data-view="downloads"] h1').textContent.trim(),
    qualities: [...document.querySelectorAll('#dlQuality option')].map((o) => o.value),
    browsers: [...document.querySelectorAll('#dlCookies option')].map((o) => o.value),
    folder: document.getElementById('dlFolder').textContent.trim(),
  })`);
  check('вкладка открывается', view.active);
  check('заголовок на месте', view.title.length > 0, view.title);
  check('качество перечислено', view.qualities.join(',') === '1080p,720p,480p,best', view.qualities.join(','));
  check('браузеры перечислены и первый — «не использовать»', view.browsers[0] === '', view.browsers.join(','));
  check('сказано, куда лягут файлы', view.folder.length > 0, view.folder);

  console.log('\n2. Разбор ссылки');
  await run(`(() => {
    const input = document.getElementById('dlInput');
    input.value = ${JSON.stringify(LINK)};
    document.getElementById('dlResolve').click();
  })()`);
  let card = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    card = await run(`(() => {
      const box = document.getElementById('dlInfo');
      const el = box.querySelector('.dl-card');
      return el ? { text: el.textContent.replace(/\\s+/g, ' ').trim(), thumb: Boolean(box.querySelector('.dl-thumb')) } : null;
    })()`);
    if (card) break;
  }
  check('карточка появилась до загрузки', card !== null, card ? card.text.slice(0, 90) : 'нет');
  if (card) {
    check('в карточке есть размер или длительность', /\d/.test(card.text));
    check('есть превью', card.thumb);
    check('есть кнопка «Скачать»', await run(`Boolean(document.getElementById('dlStart'))`));
  }
  // Номера элементов нужны только плейлисту: у одиночного видео выбирать нечего.
  const items = await run(`(() => {
    const el = document.getElementById('dlItems');
    return { exists: Boolean(el), disabled: el ? el.disabled : null };
  })()`);
  check('поле номеров плейлиста есть и для одиночного видео выключено', items.exists && items.disabled === true);
  fs.writeFileSync(path.join(outDir, 'downloads-resolve.png'), (await window.webContents.capturePage()).toPNG());

  console.log('\n3. Загрузка и прогресс');
  // Только звук: проверяем интерфейс, а не канал.
  await run(`(() => {
    const audio = document.getElementById('dlAudioOnly');
    audio.checked = true;
    audio.dispatchEvent(new Event('change'));
    document.getElementById('dlStart').click();
  })()`);
  let job = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    job = await run(`(() => {
      const el = document.querySelector('#dlActive .dl-job');
      return el ? { text: el.textContent.replace(/\\s+/g, ' ').trim(), hasCancel: Boolean(document.getElementById('dlCancel')) } : null;
    })()`);
    if (job) break;
  }
  check('карточка загрузки появилась', job !== null, job ? job.text.slice(0, 80) : 'нет');
  check('есть кнопка отмены', Boolean(job && job.hasCancel));
  const badge = await run(`document.getElementById('dlBadge').textContent.trim()`);
  check('в меню виден значок идущей работы', badge.length > 0, badge);
  await sleep(2500);
  fs.writeFileSync(path.join(outDir, 'downloads-job.png'), (await window.webContents.capturePage()).toPNG());

  console.log('\n4. Отмена');
  await run(`document.getElementById('dlCancel') && document.getElementById('dlCancel').click()`);
  let status = '';
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    status = await run(`(() => {
      const el = document.querySelector('#dlActive .dl-job');
      return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    if (!status || /отмен|cancel/i.test(status)) break;
  }
  check('загрузка остановлена', !status || /отмен|cancel/i.test(status), status.slice(0, 80) || 'карточка убрана');

  check('ошибок в консоли страницы нет', errors.length === 0, errors.slice(0, 2).join(' | '));

  await server.close();
  console.log(failures === 0 ? '\nВСЁ ПРОШЛО' : `\nПРОВАЛЕНО ПРОВЕРОК: ${failures}`);
  app.exit(failures === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
