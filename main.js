'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const config = require('./src/main/config');
const releases = require('./src/main/releases');
const backend = require('./src/main/backend-stub');
const ipsw = require('./src/main/ipsw');

let win = null;
let ipswAbort = null;

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'iMediaTek',
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    vibrancy: mac ? 'sidebar' : undefined,
    visualEffectState: 'followWindow',
    backgroundColor: mac ? '#00000000' : '#1c1c1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Links never navigate the app window; they open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

app.whenReady().then(() => {
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    manifestUrl: config.MANIFEST_URL,
    releasesDir: path.join(app.getPath('userData'), 'releases'),
    repoUrl: config.REPO_URL,
  }));

  ipcMain.handle('manifest:fetch', () => releases.fetchManifest());

  ipcMain.handle('release:download', (event, manifest) =>
    releases.downloadRelease(manifest, app.getPath('userData'), (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('release:progress', progress);
    })
  );

  ipcMain.handle('backend:run', (event, step, params) =>
    backend.run(step, params, (line) => {
      if (!event.sender.isDestroyed()) event.sender.send('backend:log', line);
    })
  );

  const ipswDir = () => path.join(app.getPath('userData'), 'ipsw');
  const ipswProgress = (event) => (p) => { if (!event.sender.isDestroyed()) event.sender.send('ipsw:progress', p); };

  ipcMain.handle('ipsw:status', (event, info) => ({ ...ipsw.status(info, ipswDir()), dir: ipswDir() }));

  ipcMain.handle('ipsw:download', async (event, info) => {
    if (ipswAbort) throw new Error('a download is already running');
    ipswAbort = new AbortController();
    try {
      return await ipsw.download(info, ipswDir(), ipswProgress(event), ipswAbort.signal);
    } finally {
      ipswAbort = null;
    }
  });

  ipcMain.handle('ipsw:pause', () => { if (ipswAbort) ipswAbort.abort(); });

  ipcMain.handle('ipsw:pick', async (event, info) => {
    const picked = await dialog.showOpenDialog(win, { title: 'Choose the iOS IPSW', properties: ['openFile'], filters: [{ name: 'iOS firmware', extensions: ['ipsw'] }] });
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
    return ipsw.verifyFile(picked.filePaths[0], info, ipswProgress(event));
  });

  ipcMain.handle('shell:open', (event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url);
    return undefined;
  });

  ipcMain.handle('shell:reveal', (event, dir) => {
    if (typeof dir === 'string') return shell.showItemInFolder(dir);
    return undefined;
  });

  createWindow();
  if (process.env.IMEDIATEK_SHOTS) require('./scripts/shots')(() => win, process.env.IMEDIATEK_SHOTS);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
