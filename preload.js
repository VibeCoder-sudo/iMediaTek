'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('imediatek', {
  info: () => ipcRenderer.invoke('app:info'),
  fetchManifest: () => ipcRenderer.invoke('manifest:fetch'),
  downloadRelease: (manifest) => ipcRenderer.invoke('release:download', manifest),
  onDownloadProgress: (callback) => subscribe('release:progress', callback),
  runStep: (step, params) => ipcRenderer.invoke('backend:run', step, params),
  onBackendLog: (callback) => subscribe('backend:log', callback),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openFolder: (dir) => ipcRenderer.invoke('shell:reveal', dir),
});
