const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: text => ipcRenderer.send('whip-crack', text),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onBand: (fn) => ipcRenderer.on('band-motion', (_e, m) => fn(m)),
  onVoice: (fn) => ipcRenderer.on('voice-cheer', (_e, text) => fn(text)),
  onVoiceLevel: (fn) => ipcRenderer.on('voice-level', (_e, v) => fn(v)),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onControlState: (fn) => ipcRenderer.on('control-state', (_e, s) => fn(s)),
  getControlState: () => ipcRenderer.invoke('control-get'),
  onSparkles: (fn) => ipcRenderer.on('sparkles', (_e, on) => fn(on)),
  setSparkles: (on) => ipcRenderer.send('sparkles-set', on),
  setWords: on => ipcRenderer.send('words-set', on),
  setGlow: (on) => ipcRenderer.send('control-set', on),
});
