const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onBand: (fn) => ipcRenderer.on('band-motion', (_e, m) => fn(m)),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
});
