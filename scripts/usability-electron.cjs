// Exercise the real entry point with an isolated profile and hidden window.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(process.cwd(), 'electron-profile'));
BrowserWindow.prototype.show = function () {};
require('../electron/main.cjs');
