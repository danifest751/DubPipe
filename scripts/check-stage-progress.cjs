/**
 * Проверка хода стадий на странице файла: запускаем задачу на тестовом ролике
 * и смотрим, что у идущей стадии есть подпись, полоса и таймер, а у готовой — время.
 *
 * Запуск: npx electron scripts/check-stage-progress.cjs
 * Снимок: scripts/screens/project-progress.png
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

  // server.url уже содержит «/?token=…» — для API нужен только адрес.
  const base = new URL(server.url).origin;
  const input = path.resolve(__dirname, '..', 'tests', 'fixtures', 'sample.mp4');
  const started = await fetch(`${base}/api/jobs?token=${server.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Стадия распознавания запускается принудительно: из кэша она прошла бы мгновенно.
    body: JSON.stringify({ input, fromStage: 's2', toStage: 's2' }),
  });
  if (started.status !== 202) throw new Error(`задача не запустилась: ${started.status} ${await started.text()}`);
  // Страница файла открывается щелчком по индикатору задачи в боковой панели.
  await sleep(600);
  await run(`(() => { const chip = document.getElementById('jobChip'); if (chip && !chip.hidden) chip.click(); return Boolean(chip); })()`);
  await sleep(800);

  const samples = [];
  let best = null;
  for (let i = 0; i < 80; i++) {
    const snapshot = await run(`(() => {
      const running = document.querySelector('.step.running');
      const done = [...document.querySelectorAll('.step.done')].map((s) => ({ id: s.querySelector('b').textContent, time: s.querySelector('.time')?.textContent ?? null }));
      return {
        status: document.getElementById('projectStatus')?.textContent ?? null,
        running: running ? {
          id: running.querySelector('b').textContent,
          sub: running.querySelector('.sub').textContent,
          bar: Boolean(running.querySelector('.bar')),
          indeterminate: Boolean(running.querySelector('.bar.indeterminate')),
          width: running.querySelector('.bar i')?.style.width ?? null,
          time: running.querySelector('.time')?.textContent ?? null,
        } : null,
        done,
      };
    })()`);
    samples.push(snapshot);
    if (snapshot.running && snapshot.running.bar && snapshot.running.time && (!best || (!best.running.indeterminate && !snapshot.running.indeterminate ? false : snapshot.running.indeterminate === false))) {
      best = snapshot;
      fs.writeFileSync(path.join(outDir, 'project-progress.png'), (await window.webContents.capturePage()).toPNG());
    }
    const { job } = await (await fetch(`${base}/api/state?token=${server.token}`)).json();
    if (job && job.status !== 'running') break;
    await sleep(700);
  }
  await sleep(500);
  const final = await run(`(() => [...document.querySelectorAll('.step')].map((s) => ({ id: s.querySelector('b').textContent, cls: s.className, sub: s.querySelector('.sub').textContent, time: s.querySelector('.time')?.textContent ?? null })))()`);
  fs.writeFileSync(path.join(outDir, 'project-progress-done.png'), (await window.webContents.capturePage()).toPNG());

  const sawRunningWithBar = samples.some((s) => s.running && s.running.bar && s.running.time);
  const sawDetail = samples.some((s) => s.running && s.running.sub && s.running.sub !== 'выполняется…');
  const doneWithTime = final.some((s) => s.cls.includes('done') && s.time);
  console.log(JSON.stringify({ samples: samples.length, best, final }, null, 1));
  const ok = sawRunningWithBar && sawDetail && doneWithTime;
  console.log(`полоса и таймер у идущей стадии: ${sawRunningWithBar}; подпись хода: ${sawDetail}; время у готовой: ${doneWithTime}`);
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  await server.close?.();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
