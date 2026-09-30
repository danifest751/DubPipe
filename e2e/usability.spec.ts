/// <reference lib="dom" />
import { test, expect, _electron, type Page } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const runtime = path.resolve('output/playwright/runtime');
let url: string;
let token: string;
let baseline: any;
const interview = path.join(runtime, 'media/Interview.mp4');
const lesson = path.join(runtime, 'media/Lesson.mp4');

test.beforeAll(async ({ request }) => {
  ({ url, token } = JSON.parse(await readFile(path.join(runtime, 'server.json'), 'utf8')));
  baseline = await (await request.get(`${new URL(url).origin}/api/segments?token=${token}&input=${encodeURIComponent(interview)}`)).json();
});

test.beforeEach(async ({ page }) => {
  if (!path.resolve(baseline.dir).startsWith(path.join(runtime, 'cache') + path.sep)) throw new Error('Unsafe fixture workspace');
  await writeFile(path.join(baseline.dir, 'segments.json'), JSON.stringify(baseline.segments));
  await writeFile(path.join(baseline.dir, 'overrides.json'), JSON.stringify({ voices: {}, names: {}, mix: {}, refs: {} }));
  for (const name of ['pending-review.json', 'cues.source.json', 'cues.target.json']) await rm(path.join(baseline.dir, name), { force: true });
  await page.addInitScript(() => localStorage.setItem('dubpipe-legal-accepted', '1'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#libraryList [data-open]')).toHaveCount(3);
  // Every scenario also checks for uncaught renderer exceptions.
  (page as any).rendererErrors = errors;
});

test.afterEach(async ({ page }) => {
  expect((page as any).rendererErrors).toEqual([]);
});

async function openInterview(page: Page) {
  await page.locator(`[data-open=${JSON.stringify(interview)}]`).click();
  await page.locator('#subtabs [data-sub="preview"]').click();
  await expect(page.locator('#reviewVideo')).toBeVisible();
}

async function segmentsTab(page: Page) {
  await page.locator('#subtabs [data-sub="segments"]').click();
  await expect(page.locator('#segmentsTable tbody tr[data-index]')).toHaveCount(3);
}

test('library search and filters distinguish originals, results and unprocessed files', async ({ page }) => {
  await page.locator('#librarySearch').fill('lesson');
  await expect(page.locator('#libraryList [data-open]')).toHaveCount(1);
  await page.locator('#librarySearch').fill('missing');
  await expect(page.locator('#libraryList')).toContainText('Нет файлов по этому запросу');
  await page.locator('#librarySearch').fill('');
  await page.locator('#libraryFilter').selectOption('source');
  await expect(page.locator('#libraryList [data-open]')).toHaveCount(2);
  await page.locator('#libraryFilter').selectOption('ready');
  await expect(page.locator('#libraryList [data-open]')).toHaveCount(2);
  await page.locator('#libraryFilter').selectOption('new');
  await expect(page.locator('#libraryList [data-open]')).toHaveCount(1);
});

test('opening a source or subtitles prepares it without starting a job', async ({ page }) => {
  const jobs: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') jobs.push(request.url()); });
  await page.locator(`[data-open=${JSON.stringify(lesson)}]`).click();
  await expect(page.locator('#projectName')).toHaveText('Lesson.mp4');
  await expect(page.locator('#startJob')).toBeEnabled();
  await expect(page.locator('#outPreview')).toBeVisible();
  await page.locator('#backToLibrary').click();
  await page.locator(`[data-subs=${JSON.stringify(interview)}]`).click();
  await expect(page.locator('[data-subview="subtitles"]')).toBeVisible();
  expect(jobs).toHaveLength(0);
});

test('studio keeps preview beside replicas and switches to dedicated tools', async ({ page }) => {
  await openInterview(page);
  await expect(page.locator('#reviewText')).toHaveValue(baseline.segments[0].text_ru);
  await expect(page.locator('#stageDetails')).not.toHaveAttribute('open');
  for (const name of ['segments', 'subtitles', 'compare', 'log']) {
    await page.locator(`#subtabs [data-sub="${name}"]`).click();
    await expect(page.locator(`[data-subview="${name}"]`)).toBeVisible();
    if (name === 'segments') await expect(page.locator('#reviewVideo')).toBeVisible();
    else await expect(page.locator('#review')).not.toBeVisible();
  }
  await page.locator('#subtabs [data-sub="preview"]').click();
  await expect(page.locator('#review')).toBeVisible();
});

test('searching replicas keeps edits and row identifiers stable', async ({ page }) => {
  await openInterview(page);
  await segmentsTab(page);
  await page.locator('#segmentsTable tr[data-index="1"] [data-field="text_ru"]').fill('Новый вопрос');
  await expect(page.locator('#saveSegments')).toBeEnabled();
  await page.locator('#segmentSearch').fill('Новый вопрос');
  await expect(page.locator('#segmentsTable tbody tr:visible')).toHaveCount(1);
  await page.locator('#saveSegments').click();
  await expect(page.locator('#projectEditStatus')).toContainText('Правки сохранены');
  await page.locator('#segmentSearch').fill('');
  await expect(page.locator('#segmentsTable tr[data-index="1"] [data-field="text_ru"]')).toHaveValue('Новый вопрос');
});

test('text edits save without processing and remain pending after reloading the app', async ({ page, request }) => {
  await openInterview(page);
  await segmentsTab(page);
  let jobs = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/jobs') jobs++; });
  await page.locator('#segmentsTable tr[data-index="0"] [data-field="text_ru"]').fill('Сохранённая правка');
  await expect(page.locator('#startJob')).toBeDisabled();
  await page.locator('#saveSegments').click();
  await expect(page.locator('#saveSegments')).toBeDisabled();
  await expect(page.locator('#projectEditStatus')).toContainText('Чтобы услышать их');
  const data = await (await request.get(`${new URL(url).origin}/api/segments?token=${token}&input=${encodeURIComponent(interview)}`)).json();
  expect(data.segments[0].text_ru).toBe('Сохранённая правка');
  expect(data.pendingReview).toBe('s5');
  expect(jobs).toBe(0);
  await page.reload();
  await openInterview(page);
  await segmentsTab(page);
  await expect(page.locator('#applySegments')).toBeEnabled();
  await expect(page.locator('#projectEditStatus')).toContainText('Чтобы услышать их');
});

test('discard restores text and time across preview and table', async ({ page }) => {
  await openInterview(page);
  await page.locator('#reviewText').fill('Отменить эту правку');
  await segmentsTab(page);
  await page.locator('#segmentsTable tr[data-index="0"] [data-field="end"]').fill('1.5');
  await page.locator('#subtabs [data-sub="preview"]').click();
  await page.locator('#reviewDiscard').click();
  await expect(page.locator('#reviewText')).toHaveValue(baseline.segments[0].text_ru);
  await segmentsTab(page);
  await expect(page.locator('#segmentsTable tr[data-index="0"] [data-field="end"]')).toHaveValue('1.80');
});

test('switching files requires deliberate discarding; ordinary navigation keeps the draft', async ({ page }) => {
  await openInterview(page);
  await page.locator('#reviewText').fill('Несохранённый текст');
  await page.locator('#backToLibrary').click();
  await page.locator(`[data-open=${JSON.stringify(interview)}]`).click();
  await expect(page.locator('#reviewText')).toHaveValue('Несохранённый текст');
  await page.locator('#backToLibrary').click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator(`[data-open=${JSON.stringify(lesson)}]`).click();
  await expect(page.locator('#projectName')).toHaveText('Interview.mp4');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator(`[data-open=${JSON.stringify(lesson)}]`).click();
  await expect(page.locator('#projectName')).toHaveText('Lesson.mp4');
  await expect(page.locator('#saveSegments')).toBeDisabled();
});

test('invalid timing cannot be saved and the same save click works after correction', async ({ page }) => {
  await openInterview(page);
  await segmentsTab(page);
  const end = page.locator('#segmentsTable tr[data-index="0"] [data-field="end"]');
  await end.fill('-1');
  await expect(end).toHaveClass(/invalid/);
  await end.fill('1.4');
  await expect(end).not.toHaveClass(/invalid/);
  await page.locator('#saveSegments').click();
  await expect(page.locator('#saveSegments')).toBeDisabled();
  await expect(page.locator('#projectEditStatus')).toContainText('Правки сохранены');
});

test('failed saving preserves the draft and supports retry', async ({ page }) => {
  await openInterview(page);
  await page.locator('#reviewText').fill('Повторное сохранение');
  await page.route('**/api/project/review?*', (route) => route.fulfill({ status: 503, json: { error: 'Тест: сервер занят' } }));
  await page.locator('#reviewSave').click();
  await expect(page.locator('#toasts')).toContainText('Тест: сервер занят');
  await expect(page.locator('#reviewSave')).toBeEnabled();
  await page.unroute('**/api/project/review?*');
  await page.locator('#reviewSave').click();
  await expect(page.locator('#reviewSave')).toBeDisabled();
});

test('output folder and stage range are checked before a job request', async ({ page }) => {
  await page.locator(`[data-open=${JSON.stringify(lesson)}]`).click();
  let jobs = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/jobs') jobs++; });
  await page.locator('input[name="outMode"][value="folder"]').check();
  await page.locator('#startJob').click();
  await expect(page.locator('#toasts')).toContainText('Выберите папку для результата');
  await page.locator('input[name="outMode"][value="beside"]').check();
  await page.locator('#toggleAdvanced').click();
  await page.locator('#fromStage').selectOption('s7');
  await page.locator('#toStage').selectOption('s1');
  await page.locator('#startJob').click();
  await expect(page.locator('#toasts')).toContainText('Начальная стадия');
  expect(jobs).toBe(0);
});

test('stage selections survive language refresh and reset when opening a different video', async ({ page }) => {
  await openInterview(page);
  await page.locator('#toggleAdvanced').click();
  await page.locator('#fromStage').selectOption('s5');
  await page.locator('#toStage').selectOption('s6');
  await page.locator('#uiLang').selectOption('en');
  await expect(page.locator('#startJob')).toContainText('Start dubbing');
  await expect(page.locator('#fromStage')).toHaveValue('s5');
  await expect(page.locator('#toStage')).toHaveValue('s6');
  await page.locator('#backToLibrary').click();
  await page.locator(`[data-open=${JSON.stringify(lesson)}]`).click();
  await expect(page.locator('#fromStage')).toHaveValue('s1');
  await expect(page.locator('#toStage')).toHaveValue('s7');
});

test('subtitle draft survives tab changes, saves SRT and rebuilds deliberately', async ({ page, request }) => {
  await openInterview(page);
  await page.locator('#subtabs [data-sub="subtitles"]').click();
  const lines = page.locator('#subsTable [data-cue-field="lines"]').first();
  await lines.fill('Edited subtitle');
  await page.locator('#subtabs [data-sub="segments"]').click();
  await page.locator('#subtabs [data-sub="subtitles"]').click();
  await expect(lines).toHaveValue('Edited subtitle');
  await page.locator('#saveSubtitles').click();
  await expect(page.locator('#toasts')).toContainText('.srt');
  const data = await (await request.get(`${new URL(url).origin}/api/subtitles?token=${token}&input=${encodeURIComponent(interview)}`)).json();
  expect(data.languages.find((track: any) => track.kind === 'source').cues[0].lines).toEqual(['Edited subtitle']);
  const track = data.languages.find((item: any) => item.kind === 'source');
  expect(await readFile(track.file, 'utf8')).toContain('Edited subtitle');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#rebuildSubtitles').click();
  await expect(lines).not.toHaveValue('Edited subtitle');
});

test('settings retain unsaved form values through navigation; reverting clears the save bar', async ({ page }) => {
  await page.locator('#nav [data-view="settings"]').click();
  await page.locator('#settingsNav [data-group="audio"]').click();
  const field = page.locator('[data-key="mix.background_gain_db"]');
  const initial = await field.inputValue();
  await field.fill('-14');
  await field.dispatchEvent('input');
  await expect(page.locator('#savebar')).toBeVisible();
  await page.locator('#nav [data-view="library"]').click();
  await page.locator('#nav [data-view="settings"]').click();
  await expect(field).toHaveValue('-14');
  await page.locator('#settingsNav [data-group="yaml"]').click();
  await expect(page.locator('#toasts')).toContainText('Сохраните или отмените');
  await field.fill(initial);
  await field.dispatchEvent('input');
  await expect(page.locator('#savebar')).not.toBeVisible();
});

test('settings save to the isolated config and YAML draft has a clear save state', async ({ page, request }) => {
  await page.locator('#nav [data-view="settings"]').click();
  await page.locator('#settingsNav [data-group="audio"]').click();
  await page.locator('[data-key="mix.background_gain_db"]').fill('-9');
  await page.locator('[data-key="mix.background_gain_db"]').dispatchEvent('input');
  await page.locator('#saveSettings').click();
  await expect(page.locator('#savebar')).not.toBeVisible();
  const config = await (await request.get(`${new URL(url).origin}/api/config?token=${token}`)).json();
  expect(config.parsed.mix.background_gain_db).toBe(-9);
  await page.locator('#settingsNav [data-group="yaml"]').click();
  const text = await page.locator('#configText').inputValue();
  await page.locator('#configText').fill(text + '\n# UI test\n');
  await expect(page.locator('#savebar')).toBeVisible();
  await page.locator('#settingsNav [data-group="voice"]').click();
  await expect(page.locator('#configText')).toBeVisible();
  await page.locator('#resetSettings').click();
  await expect(page.locator('#savebar')).not.toBeVisible();
});

test('file dialogs support focus, Escape and choosing the current folder', async ({ page }) => {
  await page.locator('#openOther').click();
  await expect(page.locator('#otherInput')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#otherDialog')).not.toBeVisible();
  await expect(page.locator('#openOther')).toBeFocused();
  await page.locator('#pickFolder').click();
  await expect(page.locator('#browserClose')).toBeFocused();
  await page.locator('#browserChoose').click();
  await expect(page.locator('#browser')).not.toBeVisible();
  await expect(page.locator('#libraryList [data-open]')).toHaveCount(3);
});

test('component diagnostics stay compact and their details remain available', async ({ page }) => {
  await expect(page.locator('#readinessComponents')).toBeVisible();
  await expect(page.locator('#readinessComponents')).not.toHaveAttribute('open');
  await expect(page.locator('#readinessComponents ul')).not.toBeVisible();
  await page.locator('#readinessComponents summary').click();
  await expect(page.locator('#readinessComponents ul')).toBeVisible();
  await page.locator('#readinessComponents summary').click();
  await expect(page.locator('#readinessComponents ul')).not.toBeVisible();
});

test('clearing project or all work files requires confirmation and cancel leaves the files intact', async ({ page }) => {
  let clears = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/cache/clear') clears++; });
  await openInterview(page);
  await page.locator('#toggleAdvanced').click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#clearProjectCache').click();
  await segmentsTab(page);
  await expect(page.locator('#segmentsTable tbody tr[data-index]')).toHaveCount(3);
  await page.locator('#nav [data-view="settings"]').click();
  await page.locator('#settingsNav [data-group="system"]').click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#clearAllCache').click();
  expect(clears).toBe(0);
  expect(JSON.parse(await readFile(path.join(baseline.dir, 'segments.json'), 'utf8'))).toHaveLength(3);
});

test('a pasted URL goes to download preparation; returning retains the start action', async ({ page }) => {
  await page.route('**/api/download/resolve?*', (route) => route.fulfill({ json: { info: { title: 'Test lesson', durationSeconds: 80, height: 720, bytes: 123456, isPlaylist: false, entries: [] } } }));
  let submitted: any;
  await page.route('**/api/download/jobs?*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { active: null, queue: [], history: [] } });
  });
  await page.locator('#openOther').click();
  await page.locator('#otherInput').fill('https://youtu.be/test');
  await page.locator('#otherInput').press('Enter');
  await expect(page.locator('#dlInput')).toHaveValue('https://youtu.be/test');
  await page.locator('#dlResolve').click();
  await expect(page.locator('#dlInfo')).toContainText('Test lesson');
  await expect(page.locator('#dlWholePlaylist')).not.toBeVisible();
  await page.locator('#nav [data-view="library"]').click();
  await page.locator('#nav [data-view="downloads"]').click();
  await page.locator('#dlStart').click();
  await expect.poll(() => submitted?.inputs).toEqual(['https://youtu.be/test']);
});

test('comparison shows a response and applies it through the normal save flow', async ({ page }) => {
  await page.route('**/api/compare?*', (route) => route.fulfill({ json: { models: [{ model: 'test/model', ok: true, stats: { withinTolerance: 1, total: 1, share: 1 }, elapsedMs: 100, usage: { promptTokens: 10, completionTokens: 10 }, costUsd: 0, lines: [{ id: 0, text_en: 'Welcome', text_ru: 'Вариант перевода', slot: 1.8, fits: true }] }] } }));
  await openInterview(page);
  await page.locator('#subtabs [data-sub="compare"]').click();
  await page.locator('#compareModels').fill('test/model');
  await page.locator('#runCompare').click();
  await page.locator('#compareResult [data-apply]').click();
  await segmentsTab(page);
  await expect(page.locator('#segmentsTable tr[data-index="0"] [data-field="text_ru"]')).toHaveValue('Вариант перевода');
  await expect(page.locator('#projectEditStatus')).toContainText('Чтобы услышать их');
});

test('pending and running jobs prevent duplicate starts; another file explains the wait and can stop the job', async ({ page }) => {
  let starts = 0, stops = 0;
  await page.route('**/api/jobs?*', async (route) => {
    starts++;
    const body = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 202, json: { id: 'ui-test-job', input: body.input, mode: 'dub', status: 'running', stages: [{ id: 's1', state: 'running', startedAt: new Date().toISOString() }], warnings: [], output: null, error: null } });
  });
  await page.route('**/api/jobs/cancel?*', (route) => { stops++; return route.fulfill({ json: { ok: true } }); });
  await page.locator(`[data-open=${JSON.stringify(lesson)}]`).click();
  await page.locator('#startJob').click();
  await expect(page.locator('#startJob')).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect(page.locator('#projectStatus')).toHaveText('выполняется');
  expect(starts).toBe(1);
  await expect(page.locator('#makeSubtitles')).toBeDisabled();
  await page.locator('#backToLibrary').click();
  await openInterview(page);
  await expect(page.locator('#actionHint')).toContainText('Обрабатывается другое видео');
  await expect(page.locator('#reviewSave')).toBeDisabled();
  await expect(page.locator('#reviewApply')).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#cancelJob').click();
  await expect.poll(() => stops).toBe(1);
});

test('a failed launch leaves saved changes available for retry', async ({ page }) => {
  await openInterview(page);
  await page.locator('#mixBg').fill('-16');
  await page.locator('#mixBg').dispatchEvent('input');
  await page.route('**/api/jobs?*', (route) => route.fulfill({ status: 503, json: { error: 'Тест: запуск недоступен' } }));
  await page.locator('#reviewApply').click();
  await expect(page.locator('#toasts')).toContainText('Тест: запуск недоступен');
  await expect(page.locator('#reviewApply')).toBeEnabled();
  await expect(page.locator('#reviewSave')).toBeDisabled();
  await expect(page.locator('#reviewMarks')).toContainText('Чтобы услышать их');
  await page.reload();
  await openInterview(page);
  await expect(page.locator('#reviewApply')).toBeEnabled();
});

test('table changes appear in preview and listening uses a visible player', async ({ page }) => {
  await openInterview(page);
  await segmentsTab(page);
  await page.locator('#segmentsTable tr[data-index="0"] [data-field="text_ru"]').fill('Правка из таблицы');
  await page.locator('#subtabs [data-sub="preview"]').click();
  await expect(page.locator('#reviewText')).toHaveValue('Правка из таблицы');
  await page.locator('#reviewDiscard').click();
  await segmentsTab(page);
  await page.locator('#segmentsTable [data-play-original="0"]').click();
  await expect(page.locator('#player')).toBeVisible();
  await page.locator('#segmentsTable [data-play-target="0"]').click();
  await expect(page.locator('#reviewVideo')).toBeVisible();
});

test('real extraction starts from the UI and completes over the event stream', async ({ page }) => {
  // Deliver the launch response after the real terminal SSE event.
  await page.route('**/api/jobs?*', async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ response });
  });
  await page.locator(`[data-open=${JSON.stringify(lesson)}]`).click();
  await page.locator('#toggleAdvanced').click();
  await page.locator('#toStage').selectOption('s1');
  await page.locator('#startJob').click();
  await expect(page.locator('#projectStatus')).toHaveText('готово', { timeout: 20_000 });
  await expect(page.locator('#startJob')).toBeEnabled();
  await expect(page.locator('#projectStatus')).toHaveText('готово');
  await expect(page.locator('#stepper .step.done')).toHaveCount(1);
  await page.locator('#subtabs [data-sub="log"]').click();
  await expect(page.locator('#logView')).toContainText('S1');
});

test('real remix saves levels, writes a new playable result and clears pending edits', async ({ page, request }) => {
  await openInterview(page);
  await page.locator('#mixBg').fill('-15');
  await page.locator('#mixBg').dispatchEvent('input');
  await page.locator('#reviewApply').click();
  await expect(page.locator('#projectStatus')).toHaveText('готово', { timeout: 20_000 });
  const data = await (await request.get(`${new URL(url).origin}/api/segments?token=${token}&input=${encodeURIComponent(interview)}`)).json();
  expect(data.pendingReview).toBeNull();
  expect(data.overrides.mix.background_gain_db).toBe(-15);
  expect((await readFile(data.output)).length).toBeGreaterThan(1000);
  await expect(page.locator('#reviewVideo')).toHaveJSProperty('readyState', 4);
});

for (const width of [1400, 900, 760]) {
  test(`screens fit ${width}px in light and dark themes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const name of ['library', 'downloads', 'settings', 'environment']) {
        await page.locator(`#nav [data-view="${name}"]`).click();
        await expect(page.locator(`.view[data-view="${name}"]`)).toBeVisible();
        if (width === 760) {
          const nav = await page.locator('#nav').boundingBox();
          const footer = await page.locator('.sidebar-foot').boundingBox();
          expect(nav!.width).toBeGreaterThan(width - 32);
          expect(footer!.y).toBeGreaterThanOrEqual(nav!.y + nav!.height - 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: `output/playwright/${name}-${width}-${colorScheme}.png`, animations: 'disabled' });
      }
      await page.locator('#nav [data-view="library"]').click();
      await openInterview(page);
      for (const name of ['preview', 'segments', 'subtitles', 'compare', 'log']) {
        await page.locator(`#subtabs [data-sub="${name}"]`).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `output/playwright/project-${name}-${width}-${colorScheme}.png`, animations: 'disabled', fullPage: true });
      }
    }
  });
}

test('Electron uses the same working interface and native bridge', async () => {
  const app = await _electron.launch({ args: [path.resolve('scripts/usability-electron.cjs')], cwd: runtime });
  try {
    const page = await app.firstWindow();
    await page.locator('#legalOk').click();
    await expect(page.locator('#libraryList [data-open]')).toHaveCount(3);
    expect(await page.evaluate(() => (window as any).dubpipeNative.available)).toBe(true);
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.items.flatMap((menu) => menu.submenu?.items ?? []).find((item) => item.label === 'О программе');
      if (!item) throw new Error('About menu item is missing');
      item.click();
    });
    await expect(page.locator('#aboutDialog')).toBeVisible();
    await expect(page.locator('#aboutVersion')).toHaveText('v1.0.0');
    await page.locator('#aboutClose').click();
    await openInterview(page);
    await segmentsTab(page);
    await expect(page.locator('#saveSegments')).toBeDisabled();
    await page.screenshot({ path: 'output/playwright/electron-project.png', animations: 'disabled' });
  } finally { await app.close(); }
});


test('library shows real thumbnails and filter buttons open the selected video', async ({ page, request }) => {
  const image = page.locator('#libraryList .library-row img').first();
  await expect(image).toHaveJSProperty('complete', true);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  const source = await image.getAttribute('src');
  const response = await request.get(new URL(source!, url).href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/jpeg');
  expect((await response.body()).length).toBeGreaterThan(100);
  await page.locator('#libraryFilters [data-filter="source"]').click();
  await expect(page.locator('#libraryList [data-open]')).toHaveCount(2);
  await page.locator('#librarySearch').fill('Lesson');
  await expect(page.locator('#libraryList [data-open]')).toHaveCount(1);
  await page.locator('#libraryList [data-open]').click();
  await expect(page.locator('#projectName')).toHaveText('Lesson.mp4');
});

test('thumbnail access respects token and workspace restrictions', async ({ request }) => {
  const origin = new URL(url).origin;
  expect((await request.get(`${origin}/api/thumbnail?path=${encodeURIComponent(interview)}`)).status()).toBe(401);
  expect((await request.get(`${origin}/api/thumbnail?token=${token}&path=${encodeURIComponent(path.resolve('package.json'))}`)).status()).toBe(403);
});

for (const width of [1400, 900, 760]) {
  test(`all settings categories and advanced controls fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#nav [data-view="settings"]').click();
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const group of ['compute', 'translate', 'voice', 'asr', 'audio', 'fit', 'download', 'system', 'yaml']) {
        await page.locator(`#settingsNav [data-group="${group}"]`).click();
        const panel = page.locator(`fieldset[data-group="${group}"]`);
        await expect(panel).toBeVisible();
        await panel.locator('details').evaluateAll((nodes) => nodes.forEach((node) => (node as HTMLDetailsElement).open = true));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: `output/playwright/settings-${group}-${width}-${colorScheme}.png`, animations: 'disabled', fullPage: true });
      }
    }
  });
}

test('download queue and completed history have distinct actions and fit narrow windows', async ({ page }) => {
  await page.route('**/api/download/jobs?*', (route) => route.fulfill({ json: {
    active: { id: 'active', title: 'Текущее видео с длинным названием', status: 'running', files: [] },
    queue: [{ id: 'next', title: 'Следующий урок', status: 'running', files: [] }],
    history: [
      { id: 'done', title: 'Готовое интервью', status: 'done', files: [interview] },
      { id: 'error', title: 'Недоступное видео', status: 'error', error: 'Видео удалено автором', files: [] },
      { id: 'cancelled', title: 'Отменённая загрузка', status: 'cancelled', files: [] },
    ],
  } }));
  await page.locator('#nav [data-view="downloads"]').click();
  await expect(page.locator('#downloadQueueCount')).toHaveText('2');
  await expect(page.locator('#dlActive .dl-job')).toHaveCount(2);
  await expect(page.locator('#dlActive')).toContainText('Ожидает загрузки');
  await page.locator('#dlHistoryBlock summary').click();
  await expect(page.locator('#dlHistory [data-cancel-queued]')).toHaveCount(0);
  await expect(page.locator('#dlHistory [data-dub]')).toHaveCount(1);
  await expect(page.locator('#dlHistory')).toContainText('Видео удалено автором');
  for (const width of [1400, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `output/playwright/downloads-populated-${width}.png`, animations: 'disabled', fullPage: true });
  }
});

test('environment failure replaces loading state and refresh recovers', async ({ page }) => {
  await page.route('**/api/environment?*', (route) => route.fulfill({ status: 503, json: { error: 'Сервер временно недоступен' } }));
  await page.locator('#nav [data-view="environment"]').click();
  await expect(page.locator('#envList .notice.error')).toHaveText('Сервер временно недоступен');
  await expect(page.locator('#envList .skeleton-list')).toHaveCount(0);
  await expect(page.locator('#refreshEnv')).toBeEnabled();
  await page.screenshot({ path: 'output/playwright/environment-error.png', animations: 'disabled' });
  await page.unroute('**/api/environment?*');
  await page.locator('#refreshEnv').click();
  await expect(page.locator('#envList .environment-item').first()).toBeVisible();
  await expect(page.locator('#envSummary .environment-metric')).toHaveCount(3);
});

test('branded About dialog supports keyboard focus and both languages', async ({ page }) => {
  for (const language of ['ru', 'en']) {
    await page.locator('#uiLang').selectOption(language);
    await page.setViewportSize({ width: language === 'ru' ? 1400 : 760, height: 900 });
    await page.emulateMedia({ colorScheme: language === 'ru' ? 'dark' : 'light' });
    await page.locator('#aboutOpen').click();
    await expect(page.locator('#aboutDialog')).toBeVisible();
    await expect(page.locator('#aboutVersion')).toHaveText('v1.0.0');
    await expect(page.locator('#aboutTitle')).toHaveText(language === 'ru' ? 'О программе' : 'About');
    await expect(page.locator('#aboutClose')).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#aboutDialog'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `output/playwright/about-${language}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#aboutDialog')).not.toBeVisible();
    await expect(page.locator('#aboutOpen')).toBeFocused();
  }
});

test('missing thumbnail keeps the media row usable', async ({ page }) => {
  await page.route('**/api/thumbnail?**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.locator('#refreshLibrary').click();
  await expect(page.locator('#libraryList .library-row img').first()).toBeHidden();
  await page.locator(`[data-open=${JSON.stringify(interview)}]`).click();
  await expect(page.locator('#projectName')).toHaveText('Interview.mp4');
});
