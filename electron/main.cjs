/**
 * Оболочка рабочего стола для DubPipe (ТЗ §16.3). CommonJS — см. startServer().
 *
 * Намеренно тонкая: поднимает локальный сервер из ядра и показывает то же
 * веб-приложение, что открывается командой `dub ui`. Никакой логики конвейера
 * здесь нет и быть не должно — иначе замена оболочки (например, на Tauri)
 * потребует переписывать интерфейс, что запрещено требованием §16.2.
 */
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const here = __dirname;

let server = null;
let window = null;

/**
 * Рабочий каталог приложения.
 *
 * Ядро складывает кэш, модели и бинарники в `.dubpipe` относительно текущего
 * каталога. Для установленного приложения это недопустимо: оно может лежать
 * в Program Files, куда писать нельзя. Поэтому в упакованном виде рабочим
 * каталогом становится пользовательский профиль, а при запуске из исходников
 * поведение остаётся прежним — каталог проекта.
 */
function prepareWorkingDirectory() {
  if (!app.isPackaged) return process.cwd();
  const home = app.getPath('userData');
  process.chdir(home);
  return home;
}

/**
 * Ядро собрано в dist/ как ES-модуль и подключается динамическим импортом:
 * сама оболочка обязана быть CommonJS, потому что точку входа в формате ESM
 * Electron не загружает — приложение молча завершается, не выполнив ни строки.
 */
async function startServer() {
  const core = pathToFileURL(path.join(here, '..', 'dist', 'ui', 'server.js')).href;
  const { startUiServer } = await import(core);
  return await startUiServer({});
}

/**
 * Системные диалоги выбора. Полный путь к файлу веб-странице недоступен
 * в принципе (ограничение браузеров), поэтому его сообщает главный процесс.
 */
function registerDialogs() {
  ipcMain.handle('dubpipe:pick-folder', async (_event, initial) => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Папка с видеофайлами',
      properties: ['openDirectory'],
      ...(initial ? { defaultPath: initial } : {}),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dubpipe:pick-file', async (_event, initial) => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Выберите видео или аудио',
      properties: ['openFile'],
      filters: [
        { name: 'Видео и аудио', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'mp3', 'm4a', 'wav', 'opus', 'flac'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
      ...(initial ? { defaultPath: initial } : {}),
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

function buildMenu() {
  const template = [
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Выбрать папку с видео…',
          click: () => window?.webContents.executeJavaScript('window.dubpipePickFolder && window.dubpipePickFolder()'),
        },
        {
          label: 'Открыть служебный каталог',
          click: () => shell.openPath(path.resolve(process.cwd(), '.dubpipe')),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Обновить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Крупнее' },
        { role: 'zoomOut', label: 'Мельче' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        {
          label: 'О программе',
          click: () => {
            dialog.showMessageBox(window, {
              type: 'info',
              title: 'DubPipe',
              message: 'DubPipe — автоматический дубляж видео EN → RU',
              detail:
                'Инструмент предназначен ИСКЛЮЧИТЕЛЬНО для личного просмотра.\n\n' +
                'Публикация или распространение полученной дорожки нарушает права\n' +
                'правообладателя и правила платформ. Программа намеренно не умеет\n' +
                'ничего никуда выгружать.',
              buttons: ['Понятно'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'DubPipe',
    show: false,
    webPreferences: {
      // Страница обычная веб-страница с локального сервера: доступ к Node ей
      // не нужен и не даётся. Через preload наружу выходят только диалоги
      // выбора файлов — см. electron/preload.cjs.
      preload: path.join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Внешние ссылки уходят в системный браузер, а не подменяют окно приложения.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    prepareWorkingDirectory();
    server = await startServer();
    await window.loadURL(server.url);
  } catch (error) {
    dialog.showErrorBox(
      'Не удалось запустить DubPipe',
      `${error?.message ?? error}\n\nПроверьте, что приложение собрано полностью (каталог dist).`,
    );
    app.quit();
  }
}

app.whenReady().then(() => {
  registerDialogs();
  buildMenu();
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (server) await server.close().catch(() => undefined);
  app.quit();
});
