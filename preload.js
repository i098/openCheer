const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onBand: (fn) => ipcRenderer.on('band-motion', (_e, m) => fn(m)),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onControlState: (fn) => ipcRenderer.on('control-state', (_e, s) => fn(s)),
  getControlState: () => ipcRenderer.invoke('control-get'),
  onSparkles: (fn) => ipcRenderer.on('sparkles', (_e, on) => fn(on)),
  setSparkles: (on) => ipcRenderer.send('sparkles-set', on),
  setGlow: (on) => ipcRenderer.send('control-set', on),
});
