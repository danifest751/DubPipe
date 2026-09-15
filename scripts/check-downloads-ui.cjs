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
  /*
   * Электрон перевёл это событие на объект с полями, но старый вызов с
   * аргументами ещё жив. Читаем оба вида: иначе проверка «ошибок нет» тихо
   * ничего не проверяла бы — а это хуже, чем отсутствие проверки.
   */
  window.webContents.on('console-message', (first, level, message) => {
    const params = first && typeof first === 'object' ? first : null;
    const text = params?.message ?? message ?? '';
    const severity = params?.level ?? level;
    const isProblem = severity === 'error' || severity === 'warning' || severity === 2 || severity === 3;
    // Предупреждение Electron о CSP — про среду запуска, а не про страницу: в
    // собранном приложении его нет.
    if (isProblem && !/Electron Security Warning|Content-Security-Policy/i.test(text)) {
      errors.push(text);
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

  console.log('\n3. Очередь: две ссылки сразу');
  // Только звук: проверяем интерфейс, а не канал.
  await run(`(() => {
    const audio = document.getElementById('dlAudioOnly');
    audio.checked = true;
    audio.dispatchEvent(new Event('change'));
    document.getElementById('dlInput').value = ${JSON.stringify(LINK)} + '\\n' + ${JSON.stringify(LINK)};
    document.getElementById('dlStart').click();
  })()`);
  let cards = [];
  let maxCards = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    cards = await run(`[...document.querySelectorAll('#dlActive .dl-job')].map((el) => ({
      text: el.textContent.replace(/\\s+/g, ' ').trim(),
      cancel: Boolean(el.querySelector('[data-cancel-active]') || el.querySelector('[data-cancel-queued]')),
    }))`);
    maxCards = Math.max(maxCards, cards.length);
    if (maxCards >= 2) break;
  }
  if (maxCards < 2) {
    const diag = await run(`({
      downloads: state.downloads,
      hasStart: Boolean(document.getElementById('dlStart')),
      badge: document.getElementById('dlBadge').textContent,
    })`);
    console.log('   диагностика:', JSON.stringify(diag).slice(0, 400));
    console.log('   ошибки страницы:', errors.slice(0, 3).join(' | ').slice(0, 300));
  }
  check('карточка активной загрузки появилась', maxCards >= 1, cards[0] ? cards[0].text.slice(0, 70) : 'нет');
  check('вторая ссылка встала в очередь', maxCards >= 2, `одновременно карточек: ${maxCards}`);
  check('у обеих есть отмена', cards.every((item) => item.cancel));
  const badge = await run(`document.getElementById('dlBadge').textContent.trim()`);
  check('в меню виден значок идущей работы', badge.length > 0, badge);
  await sleep(2000);
  fs.writeFileSync(path.join(outDir, 'downloads-job.png'), (await window.webContents.capturePage()).toPNG());

  console.log('\n4. Отмена активной и переход к следующей');
  await run(`document.querySelector('#dlActive [data-cancel-active]').click()`);
  let status = '';
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    status = await run(`(() => {
      const active = document.querySelector('#dlActive .dl-job [data-cancel-active]');
      const el = document.querySelector('#dlActive .dl-job');
      return active && el ? 'идёт' : el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    if (!status) break;
  }
  // Первая отменилась, вторая либо уже пошла, либо отменилась следом — важно,
  // что очередь не зависла и карточки не остались висеть «идёт».
  const finalCards = await run(`document.querySelectorAll('#dlActive .dl-job').length`);
  check('очередь не зависла', finalCards <= 1, `карточек осталось: ${finalCards}`);
  // Останавливаем и вторую, если она успела начаться.
  await run(`(() => {
    const button = document.querySelector('#dlActive [data-cancel-active]');
    if (button) button.click();
    const queued = document.querySelector('#dlActive [data-cancel-queued]');
    if (queued) queued.click();
  })()`);
  await sleep(1500);

  check('ошибок в консоли страницы нет', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n5. Настройки: группа «Загрузки»');
  await run(`document.querySelector('#nav button[data-view="settings"]').click()`);
  await sleep(900);
  const settings = await run(`(() => {
    const group = document.querySelector('#settingsNav button[data-group="download"]');
    if (group) group.click();
    return {
      group: Boolean(group),
      quality: document.querySelector('[data-key="download.quality"]')?.value ?? null,
      container: document.querySelector('[data-key="download.container"]')?.value ?? null,
      fragments: document.querySelector('[data-key="download.concurrent_fragments"]')?.value ?? null,
      playlist: document.querySelector('[data-key="download.playlist"]')?.value ?? null,
      cookies: document.querySelector('[data-key="download.cookies_from_browser"]')?.value ?? null,
      thumbnail: document.querySelector('[data-key="download.write_thumbnail"]')?.checked ?? null,
    };
  })()`);
  check('группа есть в списке настроек', settings.group);
  check('качество подставлено из настроек', settings.quality === '1080p', String(settings.quality));
  check('контейнер подставлен', settings.container === 'mp4', String(settings.container));
  check('число фрагментов не пустое', Number(settings.fragments) >= 1, String(settings.fragments));
  check('режим плейлиста подставлен', ['ask', 'first', 'all'].includes(settings.playlist), String(settings.playlist));
  check('переключатель превью читается', typeof settings.thumbnail === 'boolean', String(settings.thumbnail));
  check('куки по умолчанию не выбраны', settings.cookies === '', JSON.stringify(settings.cookies));

  await server.close();
  console.log(failures === 0 ? '\nВСЁ ПРОШЛО' : `\nПРОВАЛЕНО ПРОВЕРОК: ${failures}`);
  app.exit(failures === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
