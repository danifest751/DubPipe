/**
 * Мост между окном приложения и системными диалогами выбора файлов.
 *
 * Страница остаётся обычной веб-страницей без доступа к Node: наружу выдаются
 * только две функции, каждая из которых просто открывает системный диалог
 * и возвращает выбранный путь. Ничего другого через мост не проходит.
 *
 * В браузере (`dub ui`) этого моста нет, и интерфейс переключается на
 * собственный обозреватель папок поверх API — поведение одинаковое.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dubpipeNative', {
  available: true,
  pickFolder: (initial) => ipcRenderer.invoke('dubpipe:pick-folder', initial),
  pickFile: (initial) => ipcRenderer.invoke('dubpipe:pick-file', initial),
  // Меню окна принадлежит приложению, поэтому язык ему сообщает страница.
  setLanguage: (code) => ipcRenderer.invoke('dubpipe:set-language', code),
});
