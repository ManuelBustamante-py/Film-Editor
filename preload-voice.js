'use strict';
// Puente mínimo para la ventana oculta de reconocimiento de voz.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceApi', {
  onConfig: (cb) => ipcRenderer.on('voice:config', (_e, c) => cb(c)),
  send: (d) => ipcRenderer.send('voice:event', d),
});
