/**
 * Проверка меню окна: оно принадлежит приложению, а не странице, поэтому
 * переключатель языка обязан доводить выбор до него через preload.
 *
 * Запускает настоящее приложение (electron/main.cjs) и читает подписи меню
 * до и после переключения языка на странице.
 *
 * Запуск: npx electron scripts/check-menu-i18n.cjs
 */
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const labels = () => (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label);

// Приложение поднимает сервер, строит меню и открывает окно само.
require(path.join(__dirname, '..', 'electron', 'main.cjs'));

async function main() {
  let window = null;
  for (let i = 0; i < 60 && !window; i++) {
    await sleep(500);
    window = BrowserWindow.getAllWindows()[0] ?? null;
    if (window && window.webContents.isLoading()) window = null;
  }
  if (!window) throw new Error('окно приложения не появилось');
  await sleep(2000);

  const run = (code) => window.webContents.executeJavaScript(code, true);
  await run(`(() => { const box = document.getElementById('legal'); if (box && !box.hidden) document.getElementById('legalOk').click(); })()`);

  const switchTo = async (code) => {
    await run(`(() => { const s = document.getElementById('uiLang'); s.value = ${JSON.stringify(code)}; s.dispatchEvent(new Event('change')); })()`);
    await sleep(900);
    return { menu: labels(), page: await run(`document.querySelector('#nav button').textContent.trim()`) };
  };

  const ru = await switchTo('ru');
  const en = await switchTo('en');
  const backToRu = await switchTo('ru');

  console.log(JSON.stringify({ ru, en, backToRu }, null, 1));
  const ok =
    ru.menu.includes('Файл') &&
    en.menu.includes('File') &&
    en.menu.every((label) => !/[А-Яа-яЁё]/.test(label)) &&
    backToRu.menu.includes('Файл') &&
    en.page === 'Videos';
  console.log(ok ? 'ПРОВЕРКА ПРОЙДЕНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА');
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1); }));
