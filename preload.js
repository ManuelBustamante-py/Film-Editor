'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openMedia: (kind) => ipcRenderer.invoke('dialog:openMedia', kind),
  saveExportPath: (opts) => ipcRenderer.invoke('dialog:saveExport', opts),
  paths: () => ipcRenderer.invoke('app:paths'),
  probe: (p) => ipcRenderer.invoke('media:probe', p),
  thumbnails: (p, info) => ipcRenderer.invoke('media:thumbnails', p, info),
  waveform: (p) => ipcRenderer.invoke('media:waveform', p),
  proxy: (p, info, id) => ipcRenderer.invoke('media:proxy', p, info, id),
  editProxy: (p, info, id) => ipcRenderer.invoke('media:editProxy', p, info, id),
  audioProxy: (p, info) => ipcRenderer.invoke('media:audioProxy', p, info),
  playbackBoost: (on) => ipcRenderer.invoke('player:boost', on),
  capabilities: () => ipcRenderer.invoke('engine:capabilities'),
  startExport: (job) => ipcRenderer.invoke('export:start', job),
  audioExtract: (p) => ipcRenderer.invoke('audio:extract', p),
  audioCut: (job) => ipcRenderer.invoke('audio:cut', job),
  audioEncode: (job) => ipcRenderer.invoke('audio:encode', job),
  saveWav: (bytes, name) => ipcRenderer.invoke('audio:saveWav', bytes, name),
  cancelJob: (id) => ipcRenderer.invoke('job:cancel', id),
  onJobProgress: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('job:progress', l);
    return () => ipcRenderer.removeListener('job:progress', l);
  },
  onOpenFiles: (cb) => ipcRenderer.on('app:openFiles', (_e, files) => cb(files)),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  saveProject: (data, filePath, saveAs) => ipcRenderer.invoke('project:save', data, filePath, saveAs),
  openProject: () => ipcRenderer.invoke('project:open'),
  setDirty: (d) => ipcRenderer.send('app:dirty', d),
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
  exportTracks: (job) => ipcRenderer.invoke('media:exportTracks', job),
  stretchVideo: (job) => ipcRenderer.invoke('media:stretch', job),
});

// Captura (búfer de repetición, grabación y voz). Cada llamada devuelve { ok, value | error }.
const on = (ch) => (cb) => {
  const l = (_e, d) => cb(d);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
};
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('captureApi', {
  state: call('capture:state'),
  system: call('capture:system'),
  autoConfig: call('capture:autoConfig'),
  caps: call('capture:caps'),
  devices: call('capture:devices'),
  setSettings: call('capture:setSettings'),
  restart: call('capture:restart'),
  startBuffer: call('capture:startBuffer'),
  stopBuffer: call('capture:stopBuffer'),
  saveClip: call('capture:saveClip'),
  startRecording: call('capture:startRecording'),
  stopRecording: call('capture:stopRecording'),
  pauseRecording: call('capture:pauseRecording'),
  mark: call('capture:mark'),
  screenshot: call('capture:screenshot'),
  toggleMic: call('capture:toggleMic'),
  recent: call('capture:recent'),
  windows: call('capture:windows'),
  forgetRecent: call('capture:forgetRecent'),
  calibrate: call('capture:calibrate'),
  identifyAudio: call('capture:identifyAudio'),
  benchmark: call('capture:benchmark'),
  onBench: on('capture:bench'),
  previewSource: call('capture:previewSource'),
  ffPreview: call('capture:ffPreview'),
  ffPreviewStop: call('capture:ffPreviewStop'),
  onFrame: on('capture:frame'),
  onFrameEnd: on('capture:frameEnd'),
  voiceDownload: call('voice:download'),
  voiceTest: call('voice:test'),
  onStatus: on('capture:status'),
  onEvent: on('capture:event'),
  onVoice: on('voice:event'),
});
