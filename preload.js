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
  ipswStatus: (info) => ipcRenderer.invoke('ipsw:status', info),
  ipswDownload: (info) => ipcRenderer.invoke('ipsw:download', info),
  ipswPause: () => ipcRenderer.invoke('ipsw:pause'),
  ipswPick: (info) => ipcRenderer.invoke('ipsw:pick', info),
  onIpswProgress: (callback) => subscribe('ipsw:progress', callback),
  listPorts: () => ipcRenderer.invoke('device:ports'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  inspectImage: (file) => ipcRenderer.invoke('image:inspect', file),
  onBackendProgress: (callback) => subscribe('backend:progress', callback),
  runStep: (step, params) => ipcRenderer.invoke('backend:run', step, params),
  onBackendLog: (callback) => subscribe('backend:log', callback),
  buildCheck: () => ipcRenderer.invoke('build:check'),
  buildImage: (manifest, ipswPath) => ipcRenderer.invoke('build:run', { manifest, ipswPath }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openFolder: (dir) => ipcRenderer.invoke('shell:reveal', dir),
});
