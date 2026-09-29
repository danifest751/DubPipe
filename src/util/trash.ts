import { rm } from 'node:fs/promises';
import { run } from './exec.js';

/**
 * Удаление файла в Корзину, а не безвозвратно.
 *
 * Из программы удаляют видео размером в гигабайты, и промах по кнопке не должен
 * стоить фильма: файл уходит из папки, но его можно вернуть. В собранном
 * приложении Корзину открывает сама Electron; при запуске из командной строки
 * на Windows — стандартный вызов .NET, которым пользуется и Проводник. Путь
 * передаётся переменной окружения, а не текстом команды: имя файла с
 * кавычками или `$` не превратится в команду PowerShell.
 *
 * `trash` — файл в Корзине, `deleted` — Корзины нет (не Windows и не
 * Electron), и файл удалён безвозвратно.
 */
export async function moveToTrash(file: string): Promise<'trash' | 'deleted'> {
  // Тестам Корзина ни к чему: прогон набора не должен её засорять.
  if (process.env['DUBPIPE_NO_TRASH'] === '1') {
    await rm(file, { force: true });
    return 'deleted';
  }
  try {
    const electron = (await import('electron')) as unknown as { shell?: { trashItem?: (path: string) => Promise<void> } };
    // Вне Electron пакет `electron` — это путь к бинарнику, а не модуль.
    if (typeof electron?.shell?.trashItem === 'function') {
      await electron.shell.trashItem(file);
      return 'trash';
    }
  } catch {
    // не Electron — пробуем дальше
  }

  if (process.platform === 'win32') {
    const script =
      'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:DUBPIPE_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, DUBPIPE_TRASH: file },
      timeoutMs: 60_000,
    });
    return 'trash';
  }

  try {
    await run('gio', ['trash', file], { timeoutMs: 60_000 });
    return 'trash';
  } catch {
    await rm(file, { force: true });
    return 'deleted';
  }
}
