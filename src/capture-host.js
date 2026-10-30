'use strict';
/*
 * Integración de la captura con Electron: ajustes persistentes, atajos globales,
 * icono en la bandeja, ventana oculta de reconocimiento de voz, calibración de
 * sincronía e IPC con la interfaz.
 */
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, desktopCapturer, screen, session, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { spawn } = require('child_process');
const engine = require('./engine');
const { Capture, mergeDefaults, listAudioDevices, listMonitors, listWindows, captureCaps, RESOLUTIONS, isMinimized, benchmark, setEncoderPreference } = require('./capture');
const system = require('./system');

const ROOT = path.join(__dirname, '..');
const VOICE_MODELS = {
  es: { label: 'Español', file: 'vosk-model-small-es-0.3.tar.gz', size: 34455485 },
  en: { label: 'Inglés', file: 'vosk-model-small-en-us-0.15.tar.gz', size: 41184862 },
};
const VOICE_BASE = 'https://ccoreilly.github.io/vosk-browser/models/';

const capture = new Capture();
let getWin = () => null;
let settings = null;
let hotkeyErrors = {};
let tray = null;
let voiceWin = null;
let voiceState = { state: 'off' };
let monitorsCache = null;
let statusTimer = null;
let recent = [];
let quitting = false;
let downloads = new Map();
let firstRun = false;
let sysInfo = null, sysRec = null, sysReady = null;

const userFile = (n) => path.join(app.getPath('userData'), n);
const modelPath = (lang) => path.join(app.getPath('userData'), 'voice-models', VOICE_MODELS[lang].file);
const mediaUrl = (p) => `media://local/${encodeURIComponent(p)}`;

function send(ch, data) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(ch, data);
}

// ---------------------------------------------------------------------------
// Ajustes y capturas recientes
// ---------------------------------------------------------------------------
function loadSettings() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(userFile('capture-settings.json'), 'utf8')); } catch { /* primera vez */ }
  firstRun = !raw;
  settings = mergeDefaults(raw);
  if (!settings.folder) settings.folder = path.join(app.getPath('videos'), 'Fotograma Studio');
  capture.configure(settings);
  try { recent = JSON.parse(fs.readFileSync(userFile('captures.json'), 'utf8')); } catch { recent = []; }
}

function saveSettings() {
  try { fs.writeFileSync(userFile('capture-settings.json'), JSON.stringify(settings, null, 2)); } catch { /* ignorar */ }
}

function saveRecent() {
  try { fs.writeFileSync(userFile('captures.json'), JSON.stringify(recent.slice(0, 60))); } catch { /* ignorar */ }
}

function recentList() {
  recent = recent.filter((r) => fs.existsSync(r.path));
  return recent.map((r) => ({ ...r, thumbUrl: r.thumb && fs.existsSync(r.thumb) ? mediaUrl(r.thumb) : null }));
}

// ---------------------------------------------------------------------------
// Adaptación al equipo: se detectan las tarjetas gráficas, el procesador y las pantallas, y
// se eligen los codificadores (la tarjeta dedicada primero). La primera vez que se abre la
// aplicación, la captura se configura sola según el equipo.
// ---------------------------------------------------------------------------
async function detectSystem() {
  sysInfo = await system.detect(screen.getAllDisplays());
  sysRec = system.recommend(sysInfo, await engine.capabilities());
  engine.setHwPreference(sysRec.hwOrder);
  setEncoderPreference(sysRec.hwOrder);
  return { info: sysInfo, rec: sysRec };
}

function applyRecommended() {
  const c = sysRec.capture;
  settings = mergeDefaults({ ...settings, ...c, video: { ...settings.video, ...c.video } });
  capture.configure(settings);
  saveSettings();
}

function ffmpegSource() {
  const p = String(engine.bin.ffmpeg || '');
  return /[\\/](resources|vendor)[\\/]ffmpeg[\\/]/i.test(p) ? 'incluido' : p === 'ffmpeg' ? 'del sistema' : 'básico (ffmpeg-static)';
}

// ---------------------------------------------------------------------------
// Atajos globales
// ---------------------------------------------------------------------------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = {};
  const seen = new Map();
  for (const [action, accel] of Object.entries(settings.hotkeys || {})) {
    if (!accel) continue;
    if (seen.has(accel)) { hotkeyErrors[action] = 'Repetido con otro atajo'; continue; }
    seen.set(accel, action);
    try {
      if (!globalShortcut.register(accel, () => hotkey(action))) hotkeyErrors[action] = 'En uso por otra aplicación';
    } catch {
      hotkeyErrors[action] = 'Combinación no válida';
    }
  }
}

function hotkey(action) {
  if (action === 'clip') saveClip('hotkey');
  else if (action === 'clipShort') saveClip('hotkey', settings.clipShortSec);
  else if (action === 'record') toggleRecording();
  else if (action === 'buffer') toggleBuffer();
  else if (action === 'pause') togglePause();
  else if (action === 'mark') addMark();
  else if (action === 'screenshot') screenshot();
  else if (action === 'muteMic') toggleMic();
}

function togglePause() {
  try { capture.pauseRecording(); } catch (e) { reportError(e); }
}

function addMark() {
  try { capture.addMark(); } catch (e) { reportError(e); }
}

async function screenshot() {
  try { return await capture.screenshot(); } catch (e) { reportError(e); return null; }
}

// Silencia o activa los micrófonos del mezclador (al momento, sin reiniciar la captura).
const isMic = (a) => /micr[oó]fono|microphone|\bmic\b/i.test(`${a.device} ${a.label}`);
function toggleMic() {
  const mics = (settings.audio || []).filter((a) => a.enabled !== false && isMic(a));
  if (!mics.length) {
    send('capture:event', { type: 'warn', message: 'No hay ningún micrófono en el mezclador.' });
    return;
  }
  const mute = !mics.every((a) => a.muted);
  settings = mergeDefaults({ ...settings, audio: settings.audio.map((a) => (mics.includes(a) ? { ...a, muted: mute } : a)) });
  capture.configure(settings);
  saveSettings();
  send('capture:event', { type: 'mic', muted: mute, audio: settings.audio });
}

// Cambios de audio que exigen reiniciar la captura (los de volumen, silencio y nombre van en vivo).
const audioKey = (list) => JSON.stringify((list || []).map((a) => [a.id, a.device, a.enabled !== false, Number(a.offsetMs) || 0, a.fx || null]));

function reportError(e) {
  send('capture:event', { type: 'error', message: e.message || String(e) });
  if (tray && !(getWin() && getWin().isVisible())) notify('Fotograma Studio', e.message || String(e));
}

async function saveClip(origin, seconds) {
  if (!capture.bufferOn) {
    send('capture:event', { type: 'warn', message: origin === 'voice' ? 'Se oyó el comando de voz, pero el búfer de repetición no está activo.' : 'El búfer de repetición no está activo.' });
    return null;
  }
  try {
    return await capture.saveClip(seconds || settings.bufferSec);
  } catch (e) {
    // Repetición del atajo o coincidencia con la voz: se ignora sin molestar.
    if (!e.busy) reportError(e);
    return null;
  }
}

async function toggleBuffer() {
  try {
    if (capture.bufferOn) await capture.stopBuffer();
    else await capture.startBuffer();
  } catch (e) { reportError(e); }
}

async function toggleRecording() {
  try {
    if (capture.rec) await capture.stopRecording();
    else await capture.startRecording();
  } catch (e) { reportError(e); }
}

// ---------------------------------------------------------------------------
// Bandeja del sistema
// ---------------------------------------------------------------------------
function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); } catch { /* ignorar */ }
}

function ensureTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Fotograma Studio');
  tray.on('click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const st = capture.status();
  const hk = settings.hotkeys || {};
  tray.setToolTip(`Fotograma Studio${st.recording ? ' · grabando' : st.buffer ? ' · búfer activo' : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Fotograma Studio', click: showWindow },
    { type: 'separator' },
    { label: `Guardar clip${hk.clip ? `\t${hk.clip}` : ''}`, enabled: st.buffer, click: () => saveClip('tray') },
    { label: `Guardar clip corto (${settings.clipShortSec} s)${hk.clipShort ? `\t${hk.clipShort}` : ''}`, enabled: st.buffer, click: () => saveClip('tray', settings.clipShortSec) },
    { label: st.buffer ? 'Detener búfer de repetición' : 'Iniciar búfer de repetición', click: toggleBuffer },
    { label: st.recording ? 'Detener grabación' : 'Iniciar grabación', click: toggleRecording },
    { label: st.paused ? 'Reanudar grabación' : 'Pausar grabación', enabled: st.recording, click: togglePause },
    { label: 'Poner marcador', enabled: st.running, click: addMark },
    { label: 'Captura de pantalla', click: screenshot },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
}

function showWindow() {
  const w = getWin();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

// Al cerrar la ventana mientras se captura, se queda en la bandeja.
function shouldHideOnClose() {
  if (quitting || !settings.closeToTray) return false;
  const st = capture.status();
  if (!(st.running || st.starting || (settings.voice.enabled && voiceWin))) return false;
  ensureTray();
  if (!shouldHideOnClose.told) {
    shouldHideOnClose.told = true;
    notify('Fotograma Studio sigue capturando', 'Los atajos y el comando de voz siguen activos. Ábrelo desde el icono de la bandeja.');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reconocimiento de voz (ventana oculta, sin conexión)
// ---------------------------------------------------------------------------
function voiceConfig() {
  const v = settings.voice;
  return {
    modelUrl: mediaUrl(modelPath(v.lang)), lang: v.lang, device: v.device || '',
    phrases: (v.phrases || []).map((p) => String(p).trim().toLowerCase()).filter(Boolean),
    cooldown: Math.max(1, Number(v.cooldown) || 4), test: !!voiceState.test,
  };
}

function syncVoice() {
  const v = settings.voice;
  const ready = v.enabled && fs.existsSync(modelPath(v.lang)) && (v.phrases || []).length;
  if (!ready) {
    if (voiceWin) { voiceWin.destroy(); voiceWin = null; }
    voiceState = { state: v.enabled && !fs.existsSync(modelPath(v.lang)) ? 'nomodel' : 'off' };
    send('voice:event', { type: 'status', ...voiceState });
    return;
  }
  if (voiceWin) { voiceWin.webContents.send('voice:config', voiceConfig()); return; }
  voiceWin = new BrowserWindow({
    show: false, width: 320, height: 200, skipTaskbar: true,
    webPreferences: { preload: path.join(ROOT, 'preload-voice.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  voiceWin.loadFile(path.join(ROOT, 'renderer', 'voice.html'));
  voiceWin.webContents.once('did-finish-load', () => voiceWin && voiceWin.webContents.send('voice:config', voiceConfig()));
  voiceWin.webContents.on('render-process-gone', () => {
    voiceWin = null;
    voiceState = { state: 'error', message: 'El reconocimiento de voz se cerró inesperadamente.' };
    send('voice:event', { type: 'status', ...voiceState });
  });
  if (process.argv.some((a) => a.startsWith('--capture='))) {
    voiceWin.webContents.on('console-message', (e) => { if (e.level === 'error') console.log(`[voz] ${e.message}`); });
  }
}

ipcMain.on('voice:event', (e, d) => {
  if (!voiceWin || e.sender !== voiceWin.webContents || !d) return;
  if (d.type === 'status') voiceState = { ...voiceState, ...d };
  if (d.type === 'trigger') saveClip('voice');
  send('voice:event', d);
});

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Fotograma-Studio' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, dest, onProgress, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Descarga fallida (HTTP ${res.statusCode})`)); return; }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => { got += c.length; onProgress(total ? got / total : 0); });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        if (total && got !== total) { fs.rm(tmp, () => {}); reject(new Error('Descarga incompleta')); return; }
        fs.renameSync(tmp, dest);
        resolve();
      }));
      res.on('error', reject);
      out.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Calibración de sincronía
// ---------------------------------------------------------------------------
async function calibrate() {
  if (!monitorsCache) monitorsCache = await listMonitors(screen.getAllDisplays());
  const mon = monitorsCache.find((m) => m.idx === (settings.video.source === 'monitor' ? settings.video.monitor : 0)) || monitorsCache[0];
  if (!mon) throw new Error('No se encontró ninguna pantalla para calibrar.');
  const display = screen.getAllDisplays().find((d) => String(d.id) === mon.displayId) || screen.getPrimaryDisplay();
  const size = 220;
  const b = display.workArea;
  const flashWin = new BrowserWindow({
    x: b.x + 60, y: b.y + 60, width: size, height: size, frame: false, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false, backgroundColor: '#000000', hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  flashWin.setAlwaysOnTop(true, 'screen-saver');
  const cb = flashWin.getContentBounds();
  const sf = display.scaleFactor || 1;
  const inset = 30;
  const rect = {
    x: Math.round((cb.x - display.bounds.x) * sf) + inset, y: Math.round((cb.y - display.bounds.y) * sf) + inset,
    w: Math.round(cb.width * sf) - inset * 2, h: Math.round(cb.height * sf) - inset * 2,
  };
  const closed = new Promise((r) => flashWin.once('closed', r));
  const flash = async () => {
    await flashWin.loadFile(path.join(ROOT, 'renderer', 'calibrate.html'));
    flashWin.showInactive();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 20000))]);
    if (!flashWin.isDestroyed()) flashWin.destroy();
  };
  try {
    return await capture.calibrate({ monitor: mon.idx, rect, flash, tmpDir: path.join(os.tmpdir(), 'fotograma-calibracion') });
  } finally {
    if (!flashWin.isDestroyed()) flashWin.destroy();
  }
}

// ---------------------------------------------------------------------------
// Vista previa de ventanas con FFmpeg (Windows Graphics Capture). Chromium no
// puede capturar algunos juegos (p. ej. VALORANT); FFmpeg sí, y así se ve
// exactamente lo que se grabará. Imágenes JPEG pequeñas a ~12 fps.
// ---------------------------------------------------------------------------
let previewProc = null;
let previewSeq = 0;
function stopFfPreview() {
  previewSeq++;
  if (previewProc) { try { previewProc.kill(); } catch { /* ignorar */ } previewProc = null; }
}

async function startFfPreview({ exe, title }) {
  stopFfPreview();
  const seq = previewSeq;
  const lc = (v) => String(v || '').toLowerCase();
  const wins = await listWindows();
  // Otra petición (o una parada) llegó mientras se buscaba la ventana.
  if (seq !== previewSeq) return { name: String(exe).replace(/\.exe$/i, ''), superseded: true };
  const w = wins.find((x) => lc(x.exe) === lc(exe) && x.title === title) || wins.find((x) => lc(x.exe) === lc(exe));
  if (!w) throw new Error(`«${String(exe).replace(/\.exe$/i, '')}» no está abierto`);
  const p = spawn(engine.bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-filter_complex',
    `gfxcapture=hwnd=${w.hwnd}:max_framerate=12:capture_cursor=0,hwdownload,format=bgra,scale=960:-2:flags=bilinear,format=yuvj420p[v]`,
    '-map', '[v]', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1'], { windowsHide: true });
  previewProc = p;
  let buf = Buffer.alloc(0);
  let err = '';
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    // Cada imagen va de FFD8 (inicio) a FFD9 (fin); solo se envía la última completa.
    let frame = null;
    for (;;) {
      const s = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (s < 0) { buf = Buffer.alloc(0); break; }
      const e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
      if (e < 0) { buf = buf.subarray(s); break; }
      frame = buf.subarray(s, e + 2);
      buf = buf.subarray(e + 2);
    }
    if (frame && previewProc === p) send('capture:frame', new Uint8Array(frame));
  });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', () => {
    if (previewProc !== p) return;
    previewProc = null;
    send('capture:frameEnd', { message: err.trim().split(/\r?\n/).pop() || 'La vista previa se detuvo' });
  });
  return { name: w.exe.replace(/\.exe$/i, '') };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function handle(ch, fn) {
  ipcMain.handle(ch, async (...a) => {
    try { return { ok: true, value: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
}

function state() {
  const v = settings.voice;
  return {
    settings, status: capture.status(), hotkeyErrors, resolutions: RESOLUTIONS, firstRun,
    voice: { ...voiceState, models: Object.fromEntries(Object.entries(VOICE_MODELS).map(([k, m]) => [k, { label: m.label, size: m.size, installed: fs.existsSync(modelPath(k)), downloading: downloads.has(k) }])), lang: v.lang },
  };
}

function setupIpc() {
  handle('capture:state', () => state());
  handle('capture:system', async () => {
    if (!sysRec) await (sysReady || detectSystem());
    if (!sysRec) await detectSystem();
    return { info: sysInfo, rec: sysRec, ffmpeg: { version: engine.bin.version, source: ffmpegSource() }, caps: await captureCaps() };
  });
  handle('capture:autoConfig', async () => {
    if (!sysRec) await (sysReady || detectSystem());
    if (capture.rec) throw new Error('Detén la grabación antes de cambiar la configuración.');
    applyRecommended();
    if (capture.session) { await capture.stopBuffer(); await capture.startBuffer(); }
    return { ...state(), rec: sysRec };
  });
  handle('capture:caps', () => captureCaps());
  handle('capture:devices', async (_e, { refreshMonitors } = {}) => {
    if (!monitorsCache || refreshMonitors) monitorsCache = await listMonitors(screen.getAllDisplays());
    const [audio, windows] = await Promise.all([listAudioDevices(), listWindows()]);
    return { audio, monitors: monitorsCache, windows };
  });
  handle('capture:setSettings', (_e, patch) => {
    const wasRunning = !!capture.session;
    const audioBefore = audioKey(settings.audio);
    firstRun = false;
    settings = mergeDefaults({ ...settings, ...patch });
    if (!settings.folder) settings.folder = path.join(app.getPath('videos'), 'Fotograma Studio');
    capture.configure(settings);
    saveSettings();
    if (patch.hotkeys) registerHotkeys();
    if (patch.voice) syncVoice();
    updateTray();
    const restartKeys = ['video', 'encoder', 'codec', 'quality', 'audioCodec', 'rate', 'bitrate', 'preset', 'mixLimiter', 'separateTracks', 'audioKbps', 'gpuPriority'];
    const needsRestart = wasRunning && (restartKeys.some((k) => k in patch) || ('audio' in patch && audioKey(settings.audio) !== audioBefore));
    return { ...state(), needsRestart };
  });
  handle('capture:restart', async () => {
    const buf = capture.bufferOn;
    if (capture.rec) throw new Error('Detén la grabación antes de aplicar los cambios.');
    if (buf) { await capture.stopBuffer(); await capture.startBuffer(); }
    return state();
  });
  handle('capture:startBuffer', () => capture.startBuffer());
  handle('capture:stopBuffer', () => capture.stopBuffer());
  handle('capture:saveClip', (_e, seconds) => capture.saveClip(seconds || settings.bufferSec));
  handle('capture:pauseRecording', () => capture.pauseRecording());
  handle('capture:mark', () => capture.addMark());
  handle('capture:screenshot', () => capture.screenshot());
  handle('capture:toggleMic', () => { toggleMic(); return settings.audio; });
  handle('capture:startRecording', () => capture.startRecording());
  handle('capture:stopRecording', () => capture.stopRecording());
  handle('capture:recent', () => recentList());
  handle('capture:windows', () => listWindows());
  handle('capture:forgetRecent', (_e, p) => { recent = recent.filter((r) => r.path !== p); saveRecent(); return recentList(); });
  handle('capture:calibrate', () => calibrate());
  // Optimizador de fluidez: detiene el búfer mientras prueba y lo vuelve a iniciar al terminar.
  handle('capture:benchmark', async () => {
    if (capture.rec) throw new Error('Detén la grabación antes de optimizar.');
    const wasBuffer = capture.bufferOn;
    if (capture.session || capture.reconnecting || wasBuffer) await capture.stopBuffer();
    try {
      return await benchmark(settings, (st) => send('capture:bench', st));
    } finally {
      if (wasBuffer) capture.startBuffer().catch(reportError);
    }
  });
  handle('capture:identifyAudio', () => require('./audio-identify').identify((settings.audio || []).filter((a) => a.enabled !== false && a.device), 7));
  // Fuente para la vista previa en vivo (getUserMedia con chromeMediaSourceId).
  handle('capture:previewSource', async (_e, { kind, displayId, title, exe }) => {
    const sources = await desktopCapturer.getSources({ types: [kind === 'window' ? 'window' : 'screen'], thumbnailSize: { width: 0, height: 0 } });
    if (kind === 'window') {
      // Igual que la captura: se busca la ventana principal del programa y se usa su identificador
      // (los títulos pueden llevar espacios o cambiar, como «VALORANT   »).
      const lc = (v) => String(v || '').toLowerCase();
      const wins = await listWindows();
      const w = wins.find((x) => lc(x.exe) === lc(exe) && x.title === title) || wins.find((x) => lc(x.exe) === lc(exe));
      if (!w) return null;
      const s = sources.find((x) => x.id.startsWith(`window:${w.hwnd}:`)) || sources.find((x) => x.name.trim() === w.title.trim());
      return s ? s.id : `window:${w.hwnd}:0`;
    }
    const s = sources.find((x) => String(x.display_id) === String(displayId)) || sources[0];
    return s ? s.id : null;
  });
  handle('capture:ffPreview', (_e, opts) => startFfPreview(opts || {}));
  handle('capture:ffPreviewStop', () => { stopFfPreview(); return true; });
  handle('voice:download', async (_e, lang) => {
    if (!VOICE_MODELS[lang]) throw new Error('Idioma no disponible');
    if (downloads.has(lang)) return downloads.get(lang);
    const dest = modelPath(lang);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let last = 0;
    const p = download(VOICE_BASE + VOICE_MODELS[lang].file, dest, (pct) => {
      if (pct - last >= 0.01 || pct === 1) { last = pct; send('voice:event', { type: 'download', lang, pct }); }
    }).finally(() => downloads.delete(lang));
    downloads.set(lang, p);
    await p;
    syncVoice();
    return state();
  });
  handle('voice:test', (_e, on) => {
    voiceState.test = !!on;
    if (voiceWin) voiceWin.webContents.send('voice:config', voiceConfig());
    return true;
  });
}

// ---------------------------------------------------------------------------
function init(opts) {
  getWin = opts.getWin;
  loadSettings();
  setupIpc();

  // Micrófono y captura de pantalla para la vista previa, medidores y voz.
  const allow = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'speaker-selection', 'fullscreen', 'automatic-fullscreen'];
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allow.includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allow.includes(perm) || perm === 'clipboard-sanitized-write');

  capture.on('status', () => { send('capture:status', capture.status()); updateTray(); });
  capture.on('segment', () => {});
  capture.on('event', (e) => {
    if (e.item) {
      recent.unshift(e.item);
      saveRecent();
      const w = getWin();
      if (tray && !(w && w.isVisible())) notify({ 'clip-saved': 'Clip guardado', 'shot-saved': 'Captura de pantalla guardada' }[e.type] || 'Grabación guardada', path.basename(e.item.path));
    }
    send('capture:event', e.item ? { ...e, item: { ...e.item, thumbUrl: e.item.thumb ? mediaUrl(e.item.thumb) : null } } : e);
  });
  // Si la pantalla cambia de resolución (un juego a pantalla completa), la captura se ajusta.
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => capture.onDisplayChange());
  statusTimer = setInterval(() => { if (capture.session) send('capture:status', capture.status()); }, 500);

  if (!opts.noHotkeys) registerHotkeys();
  syncVoice();
  sysReady = detectSystem().then((r) => {
    if (firstRun) {
      applyRecommended();
      send('capture:event', { type: 'info', message: `Captura configurada para tu equipo: ${r.rec.notes[0]}` });
    }
  }).catch(() => {});
  // Si la aplicación se cerró de golpe mientras grababa, se recupera lo grabado.
  capture.recover().then((item) => { if (item) notify('Grabación recuperada', path.basename(item.path)); }).catch(() => {});
  if (settings.autoStartBuffer) setTimeout(() => sysReady.finally(() => capture.startBuffer().catch(reportError)), 2500);
}

async function shutdown() {
  quitting = true;
  stopFfPreview();
  clearInterval(statusTimer);
  globalShortcut.unregisterAll();
  if (voiceWin) { voiceWin.destroy(); voiceWin = null; }
  await capture.shutdown().catch(() => {});
  if (tray) { tray.destroy(); tray = null; }
}

module.exports = {
  init, shutdown, shouldHideOnClose,
  isBusy: () => !!capture.session,
  setQuitting: () => { quitting = true; },
};
