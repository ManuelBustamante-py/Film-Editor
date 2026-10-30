'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const engine = require('./src/engine');
const captureHost = require('./src/capture-host');

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv', 'mxf', 'vob'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];
const PROJECT_EXT = 'fgproj';
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
};

// media://local/<ruta codificada>: sirve archivos locales con soporte de rangos y CORS,
// necesario para que la vista previa pueda pasar el audio por Web Audio.
protocol.registerSchemesAsPrivileged([{
  scheme: 'media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true },
}]);

async function serveMedia(req) {
  const file = decodeURIComponent(new URL(req.url).pathname.slice(1));
  let size;
  try { size = (await fs.promises.stat(file)).size; } catch { return new Response('No encontrado', { status: 404 }); }
  const headers = {
    'Content-Type': MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

let win = null;
let dirty = false;
// Solo desarrollo: perfil aislado y ventana invisible (capturas para el manual sin molestar).
const SHOTS = !!process.env.FOTOGRAMA_USERDATA && process.argv.some((a) => a.startsWith('--capture='));
if (SHOTS) app.setPath('userData', process.env.FOTOGRAMA_USERDATA);
const jobs = new Map();

function argFiles(argv) {
  const ok = [...VIDEO_EXT, ...AUDIO_EXT];
  return argv.slice(1).filter((a) => !a.startsWith('-') && fs.existsSync(a) && ok.includes(path.extname(a).slice(1).toLowerCase()));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1180, minHeight: 720,
    backgroundColor: '#07080c',
    title: 'Fotograma Studio',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      offscreen: SHOTS,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!SHOTS) win.show(); });
  if (SHOTS) win.webContents.setFrameRate(30);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  // Solo desarrollo: con --capture se muestran en la terminal los errores de la interfaz.
  if (process.argv.some((a) => a.startsWith('--capture='))) {
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[renderer ${e.level}] ${e.message} ${e.sourceId}:${e.lineNumber}`);
    });
  }
  win.webContents.once('did-finish-load', () => {
    const files = argFiles(process.argv);
    if (files.length) win.webContents.send('app:openFiles', files);
    const cap = process.argv.find((a) => a.startsWith('--capture='));
    // Solo desarrollo: --capture=archivo.png guarda una captura (FOTOGRAMA_EVAL ejecuta JS antes).
    if (cap) setTimeout(async () => {
      if (process.env.FOTOGRAMA_EVAL) {
        const code = `(async () => { try { const r = await (${process.env.FOTOGRAMA_EVAL}); return r === undefined ? 'ok' : JSON.stringify(r); } catch (e) { return 'ERROR ' + e.stack; } })()`;
        console.log('[eval]', await win.webContents.executeJavaScript(code).catch((e) => e.message));
        await new Promise((r) => setTimeout(r, Number(process.env.FOTOGRAMA_EVAL_WAIT || 1500)));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(cap.slice(10), img.toPNG());
      dirty = false;
      app.quit();
    }, Number(process.env.FOTOGRAMA_CAPTURE_DELAY || 4000));
  });

  win.on('close', (e) => {
    // Con la captura activa, cerrar la ventana la deja en la bandeja.
    if (captureHost.shouldHideOnClose()) {
      e.preventDefault();
      win.hide();
      return;
    }
    if (!dirty) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Salir sin guardar', 'Cancelar'], defaultId: 1, cancelId: 1,
      title: 'Cambios sin guardar', message: 'El proyecto tiene cambios sin guardar.', detail: '¿Seguro que quieres salir?',
    });
    if (r === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; app.quit(); });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.on('app:dirty', (_e, d) => { dirty = !!d; });

ipcMain.handle('dialog:openMedia', async (_e, kind = 'all') => {
  const filters = {
    all: [{ name: 'Vídeo y audio', extensions: [...VIDEO_EXT, ...AUDIO_EXT] }, { name: 'Vídeos', extensions: VIDEO_EXT }, { name: 'Audio', extensions: AUDIO_EXT }],
    video: [{ name: 'Vídeos', extensions: VIDEO_EXT }],
    audio: [{ name: 'Audio', extensions: AUDIO_EXT }, { name: 'Vídeos (se usa su audio)', extensions: VIDEO_EXT }],
    image: [{ name: 'Imágenes', extensions: IMAGE_EXT }],
  }[kind];
  const r = await dialog.showOpenDialog(win, {
    title: { video: 'Elegir vídeo', audio: 'Elegir audio', image: 'Elegir imagen' }[kind] || 'Importar medios',
    properties: kind === 'all' ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [...filters, { name: 'Todos los archivos', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:saveExport', async (_e, { defaultName, ext }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar archivo',
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  return path.extname(r.filePath) ? r.filePath : `${r.filePath}.${ext}`;
});

ipcMain.handle('dialog:pickFolder', async (_e, { title, defaultPath } = {}) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Elegir carpeta', defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('app:paths', () => ({ videos: app.getPath('videos'), documents: app.getPath('documents'), music: app.getPath('music') }));

ipcMain.handle('media:probe', (_e, p) => engine.probe(p));
ipcMain.handle('media:thumbnails', (_e, p, info) => engine.thumbnails(p, info));
ipcMain.handle('media:waveform', (_e, p) => engine.waveform(p));
ipcMain.handle('media:proxy', (e, p, info, id) =>
  engine.proxy(p, info, (pr) => { if (!e.sender.isDestroyed()) e.sender.send('job:progress', { id, ...pr }); }));
ipcMain.handle('engine:capabilities', () => engine.capabilities());

ipcMain.handle('export:start', async (e, job) => {
  const handle = engine.exportVideo(job, (pr) => {
    if (!e.sender.isDestroyed()) e.sender.send('job:progress', { id: job.id, ...pr });
  });
  jobs.set(job.id, handle);
  try {
    const r = await handle.promise;
    return { ok: true, path: r.path, size: r.size, elapsed: r.elapsed, encoder: r.encoder };
  } catch (err) {
    return { ok: false, cancelled: !!err.cancelled, error: err.message };
  } finally {
    jobs.delete(job.id);
  }
});

// Audio Studio
ipcMain.handle('audio:extract', (_e, p) => engine.extractAudio(p));
ipcMain.handle('audio:encode', async (e, job) => {
  const handle = engine.encodeAudio(job, (pr) => {
    if (!e.sender.isDestroyed()) e.sender.send('job:progress', { id: job.id, ...pr });
  });
  jobs.set(job.id, handle);
  try {
    const r = await handle.promise;
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, cancelled: !!err.cancelled, error: err.message };
  } finally {
    jobs.delete(job.id);
  }
});
ipcMain.handle('audio:cut', async (e, job) => {
  const handle = engine.cutAudio(job, (pr) => {
    if (!e.sender.isDestroyed()) e.sender.send('job:progress', { id: job.id, ...pr });
  });
  jobs.set(job.id, handle);
  try {
    return { ok: true, ...(await handle.promise) };
  } catch (err) {
    return { ok: false, cancelled: !!err.cancelled, error: err.message };
  } finally {
    jobs.delete(job.id);
  }
});
// Guarda un WAV renderizado en Música/Fotograma Studio para usarlo en el editor.
ipcMain.handle('audio:saveWav', async (_e, bytes, name) => {
  const dir = path.join(app.getPath('music'), 'Fotograma Studio');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[<>:"/\\|?*]+/g, '_').slice(0, 120) || 'audio';
  let file = path.join(dir, `${safe}.wav`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${safe} (${n}).wav`);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
});

// Fuentes de una grabación y estirado a 1080p (como escalador.bat).
for (const [ch, fn] of [['media:exportTracks', engine.exportTracks], ['media:stretch', engine.stretchVideo]]) {
  ipcMain.handle(ch, async (e, job) => {
    const handle = fn(job, (pr) => { if (!e.sender.isDestroyed()) e.sender.send('job:progress', { id: job.id, ...pr }); });
    jobs.set(job.id, handle);
    try {
      return { ok: true, ...(await handle.promise) };
    } catch (err) {
      return { ok: false, cancelled: !!err.cancelled, error: err.message };
    } finally {
      jobs.delete(job.id);
    }
  });
}

ipcMain.handle('job:cancel', (_e, id) => {
  const j = jobs.get(id);
  if (j) j.cancel();
  return !!j;
});

ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('fs:stat', (_e, p) => {
  try {
    const st = fs.statSync(p);
    return { exists: true, size: st.size, mtime: st.mtimeMs };
  } catch {
    return { exists: false };
  }
});

ipcMain.handle('project:save', async (_e, data, filePath, saveAs) => {
  let target = filePath;
  if (!target || saveAs) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Guardar proyecto',
      defaultPath: target || path.join(app.getPath('documents'), `Proyecto.${PROJECT_EXT}`),
      filters: [{ name: 'Proyecto de Fotograma Studio', extensions: [PROJECT_EXT] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
  return target;
});

ipcMain.handle('project:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir proyecto',
    properties: ['openFile'],
    filters: [{ name: 'Proyecto de Fotograma Studio', extensions: [PROJECT_EXT] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
});

// ---------------------------------------------------------------------------
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const files = argFiles(argv);
    if (files.length) win.webContents.send('app:openFiles', files);
  });

  app.whenReady().then(() => {
    protocol.handle('media', serveMedia);
    try {
      engine.init({ cacheDir: path.join(app.getPath('temp'), 'fotograma-studio-cache') });
    } catch (err) {
      dialog.showErrorBox('FFmpeg no encontrado', err.message);
      app.quit();
      return;
    }
    createWindow();
    captureHost.init({ getWin: () => win, noHotkeys: SHOTS });
  });

  // Antes de salir se detiene la captura (y se guarda la grabación en curso).
  let shuttingDown = false;
  app.on('before-quit', (e) => {
    captureHost.setQuitting();
    for (const j of jobs.values()) j.cancel();
    if (shuttingDown) return;
    shuttingDown = true;
    if (captureHost.isBusy()) {
      e.preventDefault();
      captureHost.shutdown().finally(() => app.quit());
    } else captureHost.shutdown();
  });
  app.on('window-all-closed', () => app.quit());
}
