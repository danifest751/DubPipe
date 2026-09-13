/**
 * Проверка режима «Просмотр и правка»: открываем озвученный проект, перематываем
 * на реплику, меняем пол голоса и громкость оригинала — пометки должны появиться,
 * кнопка «Внести правки» — стать доступной. Ничего не пересводим.
 *
 * Запуск: DUBPIPE_HOME=<каталог с config.yaml и .dubpipe> npx electron scripts/check-review.cjs
 * Снимок: scripts/screens/project-review.png
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

  // Окно показывается: скрытое окно с видео не перерисовывает кадр для снимка.
  const window = new BrowserWindow({ width: 1400, height: 1000, show: true, webPreferences: { contextIsolation: true } });
  const run = (code) => window.webContents.executeJavaScript(code, true);
  await window.loadURL(`${server.url}#token=${server.token}`);
  await sleep(1500);
  // Предупреждение о личном использовании появляется после загрузки состояния — ждём и закрываем.
  for (let i = 0; i < 10; i++) {
    const closed = await run(`(() => { const b = document.getElementById('legalOk'); const box = document.getElementById('legal'); if (box && !box.hidden) { b.click(); return true; } return false; })()`);
    if (closed) break;
    await sleep(300);
  }

  // Пустая строка совпадает с любым названием — берётся первый проект библиотеки.
  const needle = process.env.DUBPIPE_PROJECT ?? '';
  const opened = await run(`(() => { const b = [...document.querySelectorAll('[data-open]')].find((el) => el.closest('.file, .card, tr, li, div')?.textContent.includes(${JSON.stringify(needle)})); if (b) b.click(); return Boolean(b); })()`);
  if (!opened) throw new Error(needle ? `в библиотеке нет проекта с «${needle}»` : 'библиотека пуста: выберите папку с видео в приложении');
  for (let i = 0; i < 20 && (await run(`document.getElementById('review').hidden`)); i++) await sleep(300);
  const visible = !(await run(`document.getElementById('review').hidden`));
  if (!visible) throw new Error('режим просмотра не появился (нет итогового файла?)');

  await run(`(() => { const v = document.getElementById('reviewVideo'); v.currentTime = 24; v.dispatchEvent(new Event('timeupdate')); })()`);
  await sleep(400);
  const now = await run(`document.getElementById('reviewNow').textContent.replace(/\\s+/g, ' ').trim()`);
  await run(`document.getElementById('reviewGender')?.click()`);
  await run(`(() => { const s = document.getElementById('mixBg'); s.value = -12; s.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  const marks = await run(`document.getElementById('reviewMarks').textContent.replace(/\\s+/g, ' ').trim()`);
  const applyEnabled = !(await run(`document.getElementById('reviewApply').disabled`));
  await run(`(() => { const box = document.getElementById('legal'); if (box && !box.hidden) document.getElementById('legalOk').click(); document.getElementById('review').scrollIntoView({ block: 'start' }); })()`);
  await sleep(600);
  fs.writeFileSync(path.join(outDir, 'project-review.png'), (await window.webContents.capturePage()).toPNG());

  // Горизонтальной прокрутки быть не должно; если есть — назвать виновников.
  const overflow = await run(`(() => {
    const limit = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('#review *')].filter((el) => el.getBoundingClientRect().right > limit + 1)
      .slice(0, 8).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : '') + ' right=' + Math.round(el.getBoundingClientRect().right));
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.width)]; };
    const head = document.querySelector('#reviewNow .now-head');
    const children = head ? [...head.children].map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ':' + Math.round(el.getBoundingClientRect().width)) : [];
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: limit, wide, side: rect('.review-side'), now: rect('#reviewNow'), head: rect('#reviewNow .now-head'), children };
  })()`);
  console.log(JSON.stringify({ now, marks, applyEnabled, overflow }, null, 1));
  const ok = /Реплика \d+/.test(now) && /голос .* → /.test(marks) && /Оригинал: .* → -12 дБ/.test(marks) && applyEnabled && overflow.scrollWidth <= overflow.clientWidth;
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
