/**
 * Проверка кнопки «Перевод» в строке реплики: нажатие должно перемотать плеер
 * просмотра на место, где эта реплика звучит в готовом фильме, и проиграть её.
 *
 * Проверяется весь путь целиком, потому что он рвался в четырёх местах сразу:
 * колонка уезжала за край карточки, кнопка вела не тот плеер, перемотка
 * отбрасывалась до загрузки метаданных, а адрес файла не менялся после
 * пересведения, и плеер держал прежний фильм.
 *
 * Запуск: DUBPIPE_HOME=<каталог с config.yaml и .dubpipe> npx electron scripts/check-row-play.cjs
 * Снимок: scripts/screens/row-play.png
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const outDir = path.join(__dirname, 'screens');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (process.env.DUBPIPE_HOME) process.chdir(process.env.DUBPIPE_HOME);
  const core = pathToFileURL(path.join(__dirname, '..', 'dist', 'ui', 'server.js')).href;
  const { startUiServer } = await import(core);
  const server = await startUiServer({});
  fs.mkdirSync(outDir, { recursive: true });

  const window = new BrowserWindow({ width: 1400, height: 1000, show: true, webPreferences: { contextIsolation: true } });
  const run = (code) => window.webContents.executeJavaScript(code, true);
  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  for (let i = 0; i < 10; i++) {
    const closed = await run(
      `(() => { const box = document.getElementById('legal'); if (box && !box.hidden) { document.getElementById('legalOk').click(); return true; } return false; })()`,
    );
    if (closed) break;
    await sleep(300);
  }

  const needle = process.env.DUBPIPE_PROJECT ?? '';
  const opened = await run(
    `(() => { const b = [...document.querySelectorAll('[data-open]')].find((el) => el.closest('.file, .card, tr, li, div')?.textContent.includes(${JSON.stringify(needle)})); if (b) b.click(); return Boolean(b); })()`,
  );
  if (!opened) throw new Error(needle ? `в библиотеке нет проекта с «${needle}»` : 'библиотека пуста');
  // Ждём не «появилась строка», а «появились озвученные реплики»: пока таблица
  // не загрузилась, в ней стоит строка-заглушка, и проверять нечего.
  for (let i = 0; i < 40; i++) {
    const ready = await run(`document.querySelectorAll('#segmentsTable tbody [data-play-target]').length > 0`);
    if (ready) break;
    await sleep(300);
  }
  const project = await run(`document.getElementById('projectPath').textContent || document.getElementById('projectName').textContent`);
  console.log('проект:', project);

  // 1. Таблица должна помещаться в карточку: иначе до кнопки не дотянуться.
  const layout = await run(`(() => {
    const wrap = document.querySelector('.table-wrap');
    const btn = document.querySelector('#segmentsTable tbody [data-play-target]');
    return {
      rows: document.querySelectorAll('#segmentsTable tbody tr').length,
      overflow: wrap ? wrap.scrollWidth - wrap.clientWidth : -1,
      targetButtonVisible: Boolean(btn && btn.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 1),
      cast: document.querySelectorAll('#castList .cast-row').length,
      genderButtons: document.querySelectorAll('#segmentsTable tbody [data-set-gender]').length,
      nameFields: document.querySelectorAll('#castList [data-cast-name]').length,
      columnsMenu: Boolean(document.getElementById('columnPicker')),
      // Кто именно вылезает за край — чтобы не гадать над числом.
      widest: [...document.querySelectorAll('#segmentsTable thead th')].map((th, i) => ({
        column: th.textContent.trim().slice(0, 12),
        width: Math.round(th.getBoundingClientRect().width),
        content: Math.round(Math.max(0, ...[...document.querySelectorAll('#segmentsTable tbody tr')].slice(0, 20)
          .map((row) => (row.cells[i] ? row.cells[i].scrollWidth : 0)))),
      })).filter((c) => c.content > c.width + 1),
    };
  })()`);

  // 2. Нажатие на «Перевод» во второй строке: плеер просмотра должен встать
  //    на место этой реплики. Берём вторую — у первой начало близко к нулю.
  const target = await run(`(() => {
    const buttons = [...document.querySelectorAll('#segmentsTable tbody [data-play-target]')];
    const button = buttons[1] ?? buttons[0];
    if (!button) return null;
    const index = Number(button.dataset.playTarget);
    const segment = window.__seg ? null : null;
    button.click();
    return { index, before: document.getElementById('reviewVideo').currentTime };
  })()`);
  // Замеряем сразу после перемотки: видео играет, и через две секунды время
  // уже уедет — сравнивать было бы не с чем.
  await sleep(700);
  const after = await run(`(() => {
    const video = document.getElementById('reviewVideo');
    return { time: video.currentTime, paused: video.paused, src: video.getAttribute('src') ?? '', ready: video.readyState };
  })()`);

  // Ожидаемое место берём из самой таблицы: начало реплики плюс сдвиг укладки.
  const expected = await run(`(() => {
    const rows = [...document.querySelectorAll('#segmentsTable tbody tr')];
    const row = rows[${target ? target.index : 0}];
    const start = Number(row.querySelector('[data-field="start"]').value.replace(',', '.'));
    return start;
  })()`);

  await sleep(400);
  fs.writeFileSync(path.join(outDir, 'row-play.png'), (await window.webContents.capturePage()).toPNG());

  // Допуск: секунда проигрывания плюс небольшой отступ назад при перемотке.
  const seeked = after.time >= expected - 0.5 && after.time <= expected + 1.5;
  const versioned = /[?&]v=\d+/.test(after.src);
  const ok =
    layout.rows > 0 &&
    layout.overflow <= 1 &&
    layout.targetButtonVisible &&
    layout.cast > 0 &&
    layout.genderButtons > 0 &&
    layout.nameFields > 0 &&
    layout.columnsMenu &&
    seeked &&
    versioned;

  console.log(
    JSON.stringify(
      { layout, ожидалось: expected, получилось: after.time, играет: !after.paused, перемотал: seeked, меткаВерсии: versioned },
      null,
      1,
    ),
  );
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
