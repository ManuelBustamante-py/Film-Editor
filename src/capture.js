'use strict';
/*
 * Captura de pantalla y audio (lo mejor de OBS y Medal).
 *
 * Un único proceso FFmpeg captura la pantalla por GPU (Desktop Duplication o
 * Windows Graphics Capture), la codifica con el codificador de la tarjeta y
 * escribe segmentos de 1 s. Con esos segmentos se obtienen a la vez el búfer de
 * repetición (clips de los últimos N segundos) y la grabación continua, sin
 * codificar dos veces.
 *
 * Sincronía: el audio de DirectShow llega con marcas del reloj del sistema
 * (segundos desde el arranque) y el vídeo se sella con el reloj real en el
 * propio filtro; ambos se llevan a "segundos desde que empezó la captura".
 */
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const engine = require('./engine');

const SEG = 1;                 // duración de cada segmento (s)
const AUDIO_BUFFER_MS = 20;    // búfer de captura de DirectShow (ms)

const RESOLUTIONS = [
  { id: 'native', label: 'Nativa (igual que la fuente)' },
  { id: '1920x1080', label: '1920×1080 · 16:9 (estira como escalador.bat)', w: 1920, h: 1080 },
  { id: '2560x1440', label: '2560×1440 · 16:9', w: 2560, h: 1440 },
  { id: '1280x720', label: '1280×720 · 16:9', w: 1280, h: 720 },
];

const DEFAULTS = {
  video: { source: 'monitor', monitor: 0, window: null, fps: 60, cursor: true, resolution: 'native', method: 'auto', conv: 'auto' },
  audio: [],
  separateTracks: true,
  encoder: 'auto',
  codec: 'h264',
  quality: 20,
  rate: 'cqp',          // 'cqp' (calidad constante) | 'vbr' (bitrate variable) | 'cbr' (bitrate constante)
  bitrate: 40,          // Mbps (con vbr/cbr)
  preset: 'balanced',   // 'speed' | 'balanced' | 'quality'
  gpuPriority: 'high',
  audioKbps: 192,
  audioCodec: 'aac',    // 'aac' | 'opus'
  container: 'mp4',
  bufferSec: 60,
  clipShortSec: 20,     // segundo atajo de clip (más corto)
  postRollSec: 1,
  splitMin: 0,          // división automática de las grabaciones (minutos; 0 = no)
  mixLimiter: true,     // limitador en la mezcla (evita que sature)
  folder: '',
  hotkeys: { clip: 'F8', record: 'F9', buffer: 'Shift+F8', clipShort: '', mark: '', screenshot: '', pause: '', muteMic: '' },
  autoStartBuffer: false,
  closeToTray: true,
  sound: true,
  addToLibrary: true,
  voice: { enabled: false, lang: 'es', phrases: ['guarda eso', 'graba eso'], device: '', cooldown: 4 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function mergeDefaults(s) {
  const out = clone(DEFAULTS);
  if (!s || typeof s !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (s[k] === undefined) continue;
    out[k] = out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? { ...out[k], ...s[k] } : s[k];
  }
  return out;
}

function run(args, { timeout = 15000, input, cwd, onSpawn } = {}) {
  return new Promise((resolve) => {
    const p = spawn(engine.bin.ffmpeg, args, { windowsHide: true, cwd });
    if (onSpawn) onSpawn(p);
    let err = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stderr.on('data', (d) => { err += d; if (err.length > 40000) err = err.slice(-40000); });
    p.stdout.on('data', () => {});
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stderr: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stderr: err }); });
    if (input) p.stdin.end(input);
  });
}

const lastLines = (s, n = 4) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join('\n');

// ¿Sigue vivo el proceso? (señal 0: solo comprueba, no lo toca)
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------
// Dispositivos y capacidades
// ---------------------------------------------------------------------------
let filterCaps = null;
async function captureCaps() {
  if (filterCaps) return filterCaps;
  const p = spawn(engine.bin.ffmpeg, ['-hide_banner', '-filters'], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  await new Promise((r) => p.on('close', r));
  const has = (n) => new RegExp(`\\s${n}\\s`).test(out);
  const hw = (await engine.capabilities()).hw;
  filterCaps = {
    ddagrab: has('ddagrab'), gfxcapture: has('gfxcapture'), vppAmf: has('vpp_amf'), scaleD3d11: has('scale_d3d11'),
    encoders: [
      ...Object.entries(hw).map(([id, v]) => ({ id, label: v.label, h264: !!v.h264, hevc: !!v.h265 })),
      { id: 'x264', label: 'CPU (x264)', h264: true, hevc: false },
    ],
    version: engine.bin.version,
  };
  return filterCaps;
}

async function listAudioDevices() {
  const { stderr } = await run(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeout: 10000 });
  const devs = [];
  let cur = null;
  for (const line of stderr.split(/\r?\n/)) {
    const m = /"(.+)"\s+\(audio\)/.exec(line);
    if (m) { cur = { name: m[1], alt: null }; devs.push(cur); continue; }
    const a = /Alternative name\s+"(.+)"/.exec(line);
    if (a && cur && !cur.alt) cur.alt = a[1];
    else if (/\((video|none)\)/.test(line)) cur = null;
  }
  return devs;
}

// Tamaño real de cada salida de vídeo (DXGI) para relacionarla con las pantallas de Electron.
async function listMonitors(displays = []) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const { code, stderr } = await run(['-hide_banner', '-f', 'lavfi', '-i', `ddagrab=output_idx=${i}:framerate=5`, '-frames:v', '1', '-f', 'null', '-'], { timeout: 8000 });
    const m = /Video:.*?(\d{3,5})x(\d{3,5})/.exec(stderr);
    if (code !== 0 || !m) break;
    out.push({ idx: i, width: Number(m[1]), height: Number(m[2]) });
  }
  const used = new Set();
  for (const mon of out) {
    const d = displays.find((x) => !used.has(x.id) && Math.round(x.size.width * x.scaleFactor) === mon.width && Math.round(x.size.height * x.scaleFactor) === mon.height)
      || displays.find((x) => !used.has(x.id));
    if (d) { used.add(d.id); mon.displayId = String(d.id); mon.primary = !!d.primary; }
    mon.label = `Pantalla ${mon.idx + 1} · ${mon.width}×${mon.height}${mon.primary ? ' (principal)' : ''}`;
  }
  return out;
}

function listWindows() {
  return new Promise((resolve) => {
    const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowTitle -and $_.Id -ne $PID } | Select-Object Id,ProcessName,MainWindowTitle,@{n=\'H\';e={[int64]$_.MainWindowHandle}} | ConvertTo-Json -Compress';
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve([]));
    p.on('close', () => {
      try {
        let j = JSON.parse(out.trim() || '[]');
        if (!Array.isArray(j)) j = [j];
        const skip = /^(ApplicationFrameHost|TextInputHost|SystemSettings|ShellExperienceHost|electron|Fotograma Studio)$/i;
        resolve(j.filter((w) => !skip.test(w.ProcessName)).map((w) => ({ pid: w.Id, exe: `${w.ProcessName}.exe`, title: w.MainWindowTitle, hwnd: w.H }))
          .sort((a, b) => a.exe.localeCompare(b.exe)));
      } catch { resolve([]); }
    });
  });
}

// ¿Está minimizada la ventana? (Windows no envía imagen de las ventanas minimizadas.)
function isMinimized(hwnd) {
  return windowState(hwnd).then((s) => s.minimized);
}

// Estado de una ventana: minimizada y tamaño de su área de imagen (píxeles reales).
function windowState(hwnd) {
  return new Promise((resolve) => {
    const def = '[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h); '
      + '[DllImport("user32.dll")] public static extern bool GetClientRect(System.IntPtr h, out RECT r); '
      + '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); '
      + 'public struct RECT { public int L; public int T; public int R; public int B; }';
    const ps = `Add-Type -Name W -Namespace U -MemberDefinition '${def}'; [void][U.W]::SetProcessDPIAware(); $h=[System.IntPtr]${Number(hwnd) || 0}; $r=New-Object U.W+RECT; [void][U.W]::GetClientRect($h,[ref]$r); "{0} {1} {2}" -f [U.W]::IsIconic($h), ($r.R-$r.L), ($r.B-$r.T)`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({ minimized: false, w: 0, h: 0 }));
    p.on('close', () => {
      const m = /(True|False)\s+(-?\d+)\s+(-?\d+)/i.exec(out);
      resolve(m ? { minimized: /true/i.test(m[1]), w: Number(m[2]), h: Number(m[3]) } : { minimized: false, w: 0, h: 0 });
    });
  });
}

// ---------------------------------------------------------------------------
// Construcción del comando
// ---------------------------------------------------------------------------
// Expresión regular segura para gfxcapture (sin barras invertidas ni corchetes de filtro).
const exeRegex = (exe) => `(?i)${String(exe).replace(/[^A-Za-z0-9 _-]/g, '.')}$`;

// Orden de preferencia de los codificadores por GPU (la tarjeta dedicada primero); lo fija la
// detección del equipo al arrancar (src/system.js).
let encOrder = ['nvenc', 'amf', 'qsv'];
function setEncoderPreference(list) {
  if (Array.isArray(list) && list.length) encOrder = [...new Set([...list, 'nvenc', 'amf', 'qsv'])];
}

function resolveEncoder(s, caps) {
  const ids = caps.encoders.map((e) => e.id);
  let id = s.encoder;
  if (id === 'auto' || !ids.includes(id)) id = encOrder.find((x) => ids.includes(x)) || 'x264';
  const e = caps.encoders.find((x) => x.id === id);
  const codec = s.codec === 'hevc' && e.hevc ? 'hevc' : 'h264';
  const name = id === 'x264' ? 'libx264' : `${codec}_${id}`;
  return { id, codec, name, label: e.label };
}

function targetSize(s) {
  if (s.video.size) return s.video.size;
  const r = RESOLUTIONS.find((x) => x.id === s.video.resolution);
  return r && r.w ? { w: r.w, h: r.h } : null;
}

// Se capturan el doble de imágenes que los fps de salida: Windows las entrega con cierto
// desfase y, a la misma tasa, al ajustar a fps constantes muchas caían en el mismo hueco
// (unas se descartaban y otras se repetían). Medido en VALORANT: 39 → 60 fps reales.
const SRC_RATE = (F) => Math.min(240, Number(process.env.FOTOGRAMA_SRCRATE) || F * 2);

// Fuente de vídeo como filtro (o como entrada, en el caso de gdigrab).
function videoSource(s, caps) {
  const v = s.video, F = v.fps;
  // Solo pruebas: imagen sintética en lugar de la pantalla (FOTOGRAMA_FAKE_SOURCE=ancho x alto).
  if (process.env.FOTOGRAMA_FAKE_SOURCE) {
    const sz = process.env.FOTOGRAMA_FAKE_SOURCE;
    return { input: ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${sz}:rate=${F}`], hw: false };
  }
  if (v.source === 'window' && v.window) {
    if (caps.gfxcapture) {
      // Se usa el identificador exacto de la ventana principal (los programas pueden tener ventanas ocultas).
      const target = v.window.hwnd ? `hwnd=${v.window.hwnd}` : `window_exe='${exeRegex(v.window.exe)}'`;
      // Tamaño fijo: si no, Windows Graphics Capture se queda con el tamaño de la primera imagen
      // (p. ej. mientras el juego se restaura) y todo lo posterior sale encogido y borroso.
      const size = v.window.w && v.window.h ? `:width=${v.window.w}:height=${v.window.h}` : '';
      return { filter: `gfxcapture=${target}:max_framerate=${SRC_RATE(F)}:capture_cursor=${v.cursor ? 1 : 0}:resize_mode=scale_aspect${size}`, hw: true };
    }
    return { input: ['-f', 'gdigrab', '-framerate', String(F), '-draw_mouse', v.cursor ? '1' : '0', '-i', `title=${v.window.title}`], hw: false };
  }
  // Windows Graphics Capture (como OBS en Windows 10/11): aguanta mejor los juegos a pantalla
  // completa y los cambios de resolución. Desktop Duplication queda como alternativa.
  if (monitorMethod(s, caps) === 'wgc') {
    const size = v.size ? `:width=${v.size.w}:height=${v.size.h}` : '';
    return { filter: `gfxcapture=monitor_idx=${v.monitor || 0}:max_framerate=${SRC_RATE(F)}:capture_cursor=${v.cursor ? 1 : 0}:resize_mode=scale_aspect${size}`, hw: true, wgc: true };
  }
  // Como OBS: un reloj fijo a los fps de salida que, en cada tic, toma la última imagen lista.
  // Las marcas quedan perfectamente regulares (sin el desfase de sellar cada imagen al llegar).
  if (process.env.FOTOGRAMA_TICKS === '1') return { filter: `ddagrab=output_idx=${v.monitor || 0}:framerate=${F}:draw_mouse=${v.cursor ? 1 : 0}`, hw: true, ticks: true };
  // Sin duplicar fotogramas en el origen: así FFmpeg cuenta los repetidos y se conoce la tasa real.
  return { filter: `ddagrab=output_idx=${v.monitor || 0}:framerate=${SRC_RATE(F)}:draw_mouse=${v.cursor ? 1 : 0}:dup_frames=${process.env.FOTOGRAMA_DUP === '1' ? 1 : 0}`, hw: true };
}

function monitorMethod(s, caps) {
  const m = s.video.method || 'auto';
  // Automático: Desktop Duplication (en juegos a pantalla completa fue lo más fluido).
  if (m === 'wgc' && caps.gfxcapture) return 'wgc';
  return caps.ddagrab ? 'dda' : 'wgc';
}

// Variantes de conversión al formato del codificador, de la más eficiente a la más compatible.
// La conversión en la GPU solo se usa con la captura de pantalla (con ventanas puede bloquearse).
// pref: 'auto' | 'gpu' | 'cpu' (la elige el optimizador de fluidez).
function convVariants(enc, hw, size, caps, source, pref = 'auto') {
  const dda = source !== 'window';
  // Las ventanas pueden tener tamaños impares, que los codificadores no admiten.
  // Escalado rápido en la CPU (bilinear): con bicúbico no daba abasto a 60 fps.
  const sc = size ? `,scale=${size.w}:${size.h}:flags=fast_bilinear` : dda ? '' : ',crop=trunc(iw/2)*2:trunc(ih/2)*2';
  const sw = hw ? `hwdownload,format=bgra${sc},format=${enc.id === 'x264' ? 'yuv420p' : 'nv12'}` : `${sc ? sc.slice(1) + ',' : ''}format=${enc.id === 'x264' ? 'yuv420p' : 'nv12'}`;
  const gpu = [];
  if (hw && enc.id === 'amf' && caps.vppAmf) gpu.push(`vpp_amf=format=nv12${size ? `:w=${size.w}:h=${size.h}` : ''}:in_color_range=2:out_color_range=1`);
  if (hw && enc.id === 'nvenc' && caps.scaleD3d11) gpu.push(`scale_d3d11=format=nv12${size ? `:width=${size.w}:height=${size.h}` : ''}`);
  if (hw && enc.id === 'qsv') gpu.push(`hwmap=derive_device=qsv,format=qsv${size ? `,scale_qsv=w=${size.w}:h=${size.h}` : ''}`);
  // Sin conversión: la textura de la captura va directa al codificador (NVENC acepta
  // imágenes BGRA de la GPU; AMF no: falla al enviar la imagen). Si no funciona, se prueba la CPU.
  if (hw && dda && enc.id === 'nvenc') gpu.push('null');
  if (pref === 'cpu') return [sw];
  if (pref === 'gpu') return [...gpu, sw];
  // Por defecto, la GPU (mucho más rápida); si no funciona, la CPU.
  return [...gpu, sw];
}

// o: { rate, bitrate, preset } de los ajustes. Calidad constante ('cqp') reparte los bits según la
// escena; con bitrate variable o constante el tamaño del archivo es previsible (como en OBS).
function encoderArgs(enc, q, F, o = {}) {
  const g = ['-g', String(F), '-force_key_frames', `expr:gte(t,n_forced*${SEG})`];
  const rate = ['vbr', 'cbr'].includes(o.rate) ? o.rate : 'cqp';
  const mb = Math.max(2, Math.min(200, Number(o.bitrate) || 40));
  const B = `${mb}M`, peak = `${Math.round(mb * 1.5)}M`, buf = `${mb * 2}M`;
  const pr = ['speed', 'balanced', 'quality'].includes(o.preset) ? o.preset : 'balanced';
  const pick = (m) => m[pr];
  switch (enc.id) {
    case 'amf': {
      const rc = rate === 'cqp' ? ['-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2), ...(enc.codec === 'h264' ? ['-qp_b', String(q + 2)] : [])]
        : rate === 'cbr' ? ['-rc', 'cbr', '-b:v', B, '-maxrate', B, '-bufsize', buf]
          : ['-rc', 'vbr_peak', '-b:v', B, '-maxrate', peak, '-bufsize', buf];
      return ['-c:v', enc.name, '-usage', 'transcoding', '-quality', pr, ...rc,
        ...(enc.codec === 'h264' ? ['-bf', '0'] : ['-header_insertion_mode', 'gop']), ...g];
    }
    case 'nvenc': {
      const rc = rate === 'cqp' ? ['-rc', 'vbr', '-cq', String(q), '-b:v', '0']
        : rate === 'cbr' ? ['-rc', 'cbr', '-b:v', B, '-maxrate', B, '-bufsize', buf]
          : ['-rc', 'vbr', '-b:v', B, '-maxrate', peak, '-bufsize', buf];
      return ['-c:v', enc.name, '-preset', pick({ speed: 'p3', balanced: 'p5', quality: 'p7' }), '-tune', 'hq', ...rc, '-bf', '0', ...g];
    }
    case 'qsv': {
      const rc = rate === 'cqp' ? ['-global_quality', String(q)]
        : rate === 'cbr' ? ['-b:v', B, '-minrate', B, '-maxrate', B, '-bufsize', buf]
          : ['-b:v', B, '-maxrate', peak, '-bufsize', buf];
      return ['-c:v', enc.name, '-preset', pick({ speed: 'veryfast', balanced: 'faster', quality: 'medium' }), ...rc, '-look_ahead', '0', ...g];
    }
    default: {
      const rc = rate === 'cqp' ? ['-crf', String(q)]
        : rate === 'cbr' ? ['-b:v', B, '-minrate', B, '-maxrate', B, '-bufsize', buf, '-x264-params', 'nal-hrd=cbr']
          : ['-b:v', B, '-maxrate', peak, '-bufsize', buf];
      return ['-c:v', 'libx264', '-preset', pick({ speed: 'superfast', balanced: 'veryfast', quality: 'faster' }), ...rc, '-pix_fmt', 'yuv420p', ...g];
    }
  }
}

// Filtros por fuente (como los de OBS): reducción de ruido, puerta de ruido y compresor.
function audioFx(a) {
  const f = a.fx || {};
  const out = [];
  if (f.denoise) out.push('afftdn=nr=14:nf=-45:tn=1');
  if (f.gate) out.push('agate=threshold=0.015:ratio=6:attack=3:release=180:range=0.02');
  if (f.comp) out.push('acompressor=threshold=0.1:ratio=3.5:attack=8:release=150:makeup=2.5');
  return out.length ? `,${out.join(',')}` : '';
}

const sourceVolume = (a) => (a.muted ? 0 : Math.max(0, Math.min(4, Number(a.volume ?? 1))));

// Nombres de las pistas de audio: la mezcla y, si se piden, cada fuente por separado.
function trackTitles(sources, separate) {
  const name = (a) => a.label || a.device;
  if (sources.length <= 1) return sources.map(name);
  return ['Mezcla', ...(separate ? sources.map(name) : [])];
}

function buildArgs(s, caps, enc, conv, { base, nowUs, dir }) {
  const src = videoSource(s, caps);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5', '-y', '-copyts'];
  const sources = (s.audio || []).filter((a) => a.enabled !== false && a.device);
  sources.forEach((a) => {
    // Marcas del reloj del sistema → segundos desde el inicio, más el desfase manual.
    const off = -base + (Number(a.offsetMs) || 0) / 1000 - AUDIO_BUFFER_MS / 1000;
    // Solo pruebas: tono sintético en lugar del dispositivo (FOTOGRAMA_FAKE_AUDIO=1).
    if (process.env.FOTOGRAMA_FAKE_AUDIO === '1') {
      args.push('-thread_queue_size', '4096', '-use_wallclock_as_timestamps', '1', '-itsoffset', (-Date.now() / 1000).toFixed(6), '-f', 'lavfi', '-i', 'sine=f=440:r=48000:samples_per_frame=960,arealtime');
      return;
    }
    args.push('-thread_queue_size', '4096', '-f', 'dshow', '-audio_buffer_size', String(AUDIO_BUFFER_MS),
      '-itsoffset', off.toFixed(4), '-i', `audio=${a.alt || a.device}`);
  });
  // El vídeo entra como una entrada propia (con su propio hilo que recoge cada imagen en cuanto
  // llega) y se procesa en un grafo aparte del audio. Si compartieran grafo, mientras se espera
  // el siguiente bloque de audio nadie recoge las imágenes y Windows las descarta.
  const vin = sources.length;
  // Cada imagen se sella con la hora real en el instante en que su hilo la recoge (y se pasa a
  // segundos desde el inicio, como el audio). Sellarla al procesarla daba marcas en ráfagas y
  // la mayoría de imágenes se descartaban al ajustar a fps constantes.
  const stampIn = ['-use_wallclock_as_timestamps', '1', '-itsoffset', (-nowUs / 1e6).toFixed(6)];
  const DL = 'hwdownload,format=bgra';
  // Con tics regulares se conservan las marcas de la captura y solo se alinea el inicio con el
  // reloj (RTCSTART: instante en que arranca la captura), para que cuadre con el audio.
  const tick = `setpts='PTS-STARTPTS+(RTCSTART-${nowUs})/(TB*1000000)'`;
  if (src.ticks) {
    if (conv.startsWith(DL)) {
      const rest = conv.slice(DL.length).replace(/^,/, '') || 'null';
      args.push('-thread_queue_size', '64', '-f', 'lavfi', '-i', `${src.filter},${tick},${DL}`);
      args.push('-filter_complex', `[${vin}:v]${rest}[v]`);
    } else {
      args.push('-thread_queue_size', '6', '-f', 'lavfi', '-i', `${src.filter},${tick}`);
      args.push('-filter_complex', `[${vin}:v]${conv}[v]`);
    }
  } else if (src.input) {
    args.push('-thread_queue_size', '64', ...stampIn, ...src.input);
    args.push('-filter_complex', `[${vin}:v]${conv}[v]`);
  } else if (conv.startsWith(DL)) {
    // La imagen pasa a memoria nada más llegar: así no se agotan las texturas de la GPU en la cola.
    const rest = conv.slice(DL.length).replace(/^,/, '') || 'null';
    args.push('-thread_queue_size', '64', ...stampIn, '-f', 'lavfi', '-i', `${src.filter},${DL}`);
    args.push('-filter_complex', `[${vin}:v]${rest}[v]`);
  } else {
    // Conversión en la GPU: cola corta (las texturas de la GPU son limitadas).
    args.push('-thread_queue_size', '6', ...stampIn, '-f', 'lavfi', '-i', src.filter);
    args.push('-filter_complex', `[${vin}:v]${conv}[v]`);
  }
  const parts = [];
  const split = s.separateTracks && sources.length > 1;
  // Limitador con compensación de su retardo: solo actúa si la mezcla llega a saturar.
  const lim = s.mixLimiter !== false ? ',alimiter=limit=0.97:level=0:latency=1' : '';
  sources.forEach((a, i) => {
    // "volume@vN" tiene nombre para poder cambiar el volumen en vivo (ver Capture.applyLive).
    const chain = `[${i}:a]aresample=48000:async=1000:first_pts=0${audioFx(a)},volume@v${i}=volume=${sourceVolume(a).toFixed(3)}`;
    parts.push(split ? `${chain},asplit=2[am${i}][as${i}]` : `${chain}${sources.length === 1 ? lim : ''}[am${i}]`);
  });
  if (sources.length > 1) parts.push(`${sources.map((_a, i) => `[am${i}]`).join('')}amix=inputs=${sources.length}:normalize=0:duration=longest:dropout_transition=0${lim}[mix]`);
  if (parts.length) args.push('-filter_complex', parts.join(';'));
  args.push('-map', '[v]');
  if (sources.length === 1) args.push('-map', '[am0]');
  else if (sources.length > 1) {
    args.push('-map', '[mix]');
    if (split) sources.forEach((_a, i) => args.push('-map', `[as${i}]`));
  }
  args.push('-fps_mode:v', 'cfr', '-r', String(s.video.fps), ...encoderArgs(enc, Number(s.quality) || 20, s.video.fps, s));
  if (sources.length) {
    const kb = Number(s.audioKbps) || 192;
    args.push('-c:a', s.audioCodec === 'opus' ? 'libopus' : 'aac', '-b:a', `${kb}k`);
    // El reproductor de Windows no hace caso de la pista marcada como principal: reproduce la de
    // más bitrate. La mezcla va con más bitrate que las fuentes sueltas para que siempre suene ella.
    if (split) args.push('-b:a:0', `${Math.min(512, kb + 64)}k`);
  }
  args.push('-max_muxing_queue_size', '4096',
    '-f', 'segment', '-segment_time', String(SEG), '-segment_format', 'mpegts',
    '-segment_list', path.join(dir, 'list.csv'), '-segment_list_type', 'csv', '-segment_list_flags', '+live',
    path.join(dir, 'seg_%06d.ts'));
  return { args, titles: trackTitles(sources, s.separateTracks), ids: sources.map((a) => a.id), vols: sources.map(sourceVolume) };
}

// Tiempo grabado de "rec" hasta "now", sin contar las pausas.
function recElapsed(rec, now) {
  let paused = rec.pausedAt ? now - rec.pausedAt : 0;
  for (const [a, b] of rec.pauses) paused += b - a;
  return Math.max(0, now - rec.startWall - paused);
}

const newRec = (startWall, extra = {}) => ({ startWall, pauses: [], pausedAt: null, ...extra });

// Capítulos MP4 a partir de los marcadores (segundos del archivo final).
function chaptersMeta(times, duration) {
  const pts = [0, ...times.filter((t) => t > 0.5 && t < duration - 0.2)].sort((a, b) => a - b);
  let out = ';FFMETADATA1\n';
  pts.forEach((t, i) => {
    const end = i + 1 < pts.length ? pts[i + 1] : duration;
    out += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(t * 1000)}\nEND=${Math.round(end * 1000)}\ntitle=${i ? `Marcador ${i}` : 'Inicio'}\n`;
  });
  return out;
}

// Lanza FFmpeg con "args" y le pasa los segmentos por la entrada estándar.
function pipeSegs(files, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(engine.bin.ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(lastLines(err) || 'No se pudo guardar el vídeo.'))));
    p.stdin.on('error', () => {});
    (async () => {
      for (const f of files) {
        if (!fs.existsSync(f)) continue;
        await new Promise((res) => {
          const rs = fs.createReadStream(f);
          rs.on('error', res);
          rs.on('end', res);
          rs.pipe(p.stdin, { end: false });
        });
      }
      p.stdin.end();
    })();
  });
}

// Comprueba qué variante funciona con esta tarjeta y fuente (se recuerda el resultado).
const pipeCache = new Map();
async function pickPipeline(s, caps, enc) {
  const size = targetSize(s);
  const src = videoSource(s, caps);
  const key = JSON.stringify([s.video.source, src.wgc ? 'wgc' : 'dda', s.video.conv, enc.name, size, caps.version]);
  if (pipeCache.has(key)) return pipeCache.get(key);
  const variants = convVariants(enc, src.hw, size, caps, s.video.source, s.video.conv);
  // En la prueba se piden imágenes aunque la pantalla esté quieta (dup_frames=1): sin eso,
  // con el escritorio sin cambios no llegaba ninguna y la GPU se daba por mala.
  const probeSrc = src.filter ? src.filter.replace('dup_frames=0', 'dup_frames=1') : null;
  let lastErr = '';
  for (let k = 0; k < variants.length; k++) {
    const conv = variants[k];
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (src.input) args.push(...src.input, '-vf', conv);
    else args.push('-filter_complex', `${probeSrc},${conv}[v]`, '-map', '[v]');
    args.push('-frames:v', s.video.source === 'window' || src.wgc ? '1' : '8', ...encoderArgs(enc, 20, s.video.fps), '-f', 'null', '-');
    // Dos intentos por variante: un fallo puntual (p. ej. un cambio de modo de pantalla) no
    // debe hacer caer en la conversión por CPU, mucho más lenta.
    let r = await run(args, { timeout: 12000 });
    if (r.code !== 0) r = await run(args, { timeout: 12000 });
    if (r.code === 0) {
      // Solo se recuerda la opción preferida; si se usó la alternativa, se reintenta la próxima vez.
      if (k === 0) pipeCache.set(key, conv);
      return conv;
    }
    // Windows no envía imagen de las ventanas minimizadas.
    if (r.code == null && s.video.source === 'window') throw new Error('La ventana elegida no envía imagen (¿está minimizada?). Ábrela y vuelve a intentarlo.');
    lastErr = lastLines(r.stderr);
  }
  throw new Error(`No se pudo iniciar la captura con ${enc.label}.\n${lastErr}`);
}

// Tamaño actual de una salida de vídeo (para fijar el de la captura).
async function monitorSize(idx) {
  if (process.env.FOTOGRAMA_FAKE_SOURCE) { const [w, h] = process.env.FOTOGRAMA_FAKE_SOURCE.split('x').map(Number); return { w, h }; }
  const { code, stderr } = await run(['-hide_banner', '-f', 'lavfi', '-i', `ddagrab=output_idx=${idx}:framerate=5`, '-frames:v', '1', '-f', 'null', '-'], { timeout: 8000 });
  const m = /Video:.*?(\d{3,5})x(\d{3,5})/.exec(stderr);
  if (code !== 0 || !m) throw new Error(`No se pudo acceder a la pantalla.\n${lastLines(stderr, 2)}`);
  return { w: Number(m[1]) & ~1, h: Number(m[2]) & ~1 };
}

// Prioridad del proceso de captura en la GPU (como OBS): si el juego ocupa la tarjeta al
// 100 %, la captura no se queda sin imágenes. 4 = alta, 5 = tiempo real.
const GPU_CLASS = { low: 1, high: 4, max: 5 };
function setGpuPriority(pid, level) {
  const cls = GPU_CLASS[level];
  if (!cls || !pid) return Promise.resolve(false);
  return new Promise((resolve) => {
    const def = '[DllImport("gdi32.dll")] public static extern int D3DKMTSetProcessSchedulingPriorityClass(System.IntPtr h, int c);';
    const ps = `Add-Type -Name G -Namespace U -MemberDefinition '${def}'; $p=[System.Diagnostics.Process]::GetProcessById(${Number(pid)}); [U.G]::D3DKMTSetProcessSchedulingPriorityClass($p.Handle, ${cls})`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(out.trim() === '0'));
  });
}

// Saca el proceso de captura del "modo eficiencia" de Windows 11 (EcoQoS): a un proceso en
// segundo plano y sin ventana, Windows puede bajarle la velocidad de la CPU e ignorar la precisión
// de sus temporizadores, y las imágenes se recogen a destiempo. OBS hace lo mismo consigo mismo.
function disablePowerThrottling(pid) {
  if (!pid || process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    const def = '[DllImport("kernel32.dll")] public static extern bool SetProcessInformation(System.IntPtr h, int c, int[] info, int size);';
    // PROCESS_POWER_THROTTLING_STATE { Version 1, ControlMask EXECUTION_SPEED|IGNORE_TIMER_RESOLUTION, StateMask 0 } = siempre a pleno rendimiento.
    const ps = `Add-Type -Name T -Namespace U -MemberDefinition '${def}'; $p=[System.Diagnostics.Process]::GetProcessById(${Number(pid)}); [U.T]::SetProcessInformation($p.Handle, 4, [int[]](1, 5, 0), 12)`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(/true/i.test(out)));
  });
}

// ---------------------------------------------------------------------------
// Optimizador de fluidez: con el juego en marcha, prueba cada combinación de método de
// captura, conversión y prioridad, y mide cuántas imágenes nuevas por segundo llegan.
// ---------------------------------------------------------------------------
function measureVariant({ filter, conv, enc, fps, gpu, seconds = 6 }) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5',
      '-filter_complex', `${filter},${conv}[v]`, '-map', '[v]', '-fps_mode', 'cfr', '-r', String(fps),
      ...encoderArgs(enc, 20, fps), '-t', String(seconds), '-f', 'null', '-'];
    const p = spawn(engine.bin.ffmpeg, args, { windowsHide: true });
    const t0 = Date.now();
    const snaps = [];
    let buf = '', err = '';
    const prog = {};
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const eq = line.indexOf('=');
        if (eq > 0) prog[line.slice(0, eq)] = line.slice(eq + 1);
        if (line.startsWith('progress=')) snaps.push({ t: Date.now(), frames: Number(prog.frame) || 0, dups: Number(prog.dup_frames) || 0 });
      }
    });
    p.stderr.on('data', (d) => (err += d));
    setTimeout(() => setGpuPriority(p.pid, gpu), 800);
    const kill = setTimeout(() => p.kill(), (seconds + 8) * 1000);
    p.on('close', () => {
      clearTimeout(kill);
      // Se descartan los primeros segundos (arranque y aplicación de la prioridad).
      const usable = snaps.filter((x) => x.t - t0 > 2800);
      if (usable.length < 2) return resolve({ fps: 0, error: lastLines(err, 2) || 'Sin imagen' });
      const a = usable[0], b = usable[usable.length - 1];
      const real = ((b.frames - a.frames) - (b.dups - a.dups)) / ((b.t - a.t) / 1000);
      resolve({ fps: Math.max(0, Math.round(real * 10) / 10) });
    });
  });
}

async function benchmark(settings, onStep = () => {}) {
  const s = clone(settings);
  const caps = await captureCaps();
  const enc = resolveEncoder(s, caps);
  const F = s.video.fps;
  const sources = [];
  if (s.video.source === 'window') {
    if (!s.video.window) throw new Error('Elige primero la ventana del juego.');
    const wins = await listWindows();
    const w = wins.find((x) => x.exe.toLowerCase() === s.video.window.exe.toLowerCase());
    if (!w) throw new Error('El juego no está abierto.');
    const st = await windowState(w.hwnd);
    if (st.minimized || st.w < 320) throw new Error('El juego está minimizado: vuelve a él antes de que empiece la prueba.');
    sources.push({ method: 'wgc', label: 'Graphics Capture',
      filter: `gfxcapture=hwnd=${w.hwnd}:max_framerate=${SRC_RATE(F)}:capture_cursor=1:resize_mode=scale_aspect:width=${st.w & ~1}:height=${st.h & ~1}` });
  } else {
    const idx = s.video.monitor || 0;
    if (caps.gfxcapture) sources.push({ method: 'wgc', label: 'Graphics Capture', filter: `gfxcapture=monitor_idx=${idx}:max_framerate=${SRC_RATE(F)}:capture_cursor=1` });
    if (caps.ddagrab) sources.push({ method: 'dda', label: 'Desktop Duplication', filter: `ddagrab=output_idx=${idx}:framerate=${SRC_RATE(F)}:draw_mouse=1:dup_frames=0` });
  }
  const convs = [];
  if (enc.id === 'amf' && caps.vppAmf) convs.push({ conv: 'gpu', label: 'conversión en GPU', f: 'vpp_amf=format=nv12:in_color_range=2:out_color_range=1' });
  if (enc.id === 'nvenc' && caps.scaleD3d11) convs.push({ conv: 'gpu', label: 'conversión en GPU', f: 'scale_d3d11=format=nv12' });
  convs.push({ conv: 'cpu', label: 'conversión en CPU', f: `hwdownload,format=bgra,crop=trunc(iw/2)*2:trunc(ih/2)*2,format=${enc.id === 'x264' ? 'yuv420p' : 'nv12'}` });
  const combos = [];
  for (const src of sources) for (const c of convs) combos.push({ ...src, conv: c.conv, convLabel: c.label, convFilter: c.f, gpu: 'max' });
  const total = combos.length + 1;
  const results = [];
  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    onStep({ i: i + 1, total, label: `${c.label} · ${c.convLabel}` });
    const r = await measureVariant({ filter: c.filter, conv: c.convFilter, enc, fps: F, gpu: c.gpu });
    results.push({ ...c, ...r });
  }
  // La mejor combinación se repite con prioridad «alta»: si rinde casi igual, molesta menos al juego.
  const best = [...results].sort((a, b) => b.fps - a.fps)[0];
  if (best && best.fps > 0) {
    onStep({ i: total, total, label: `${best.label} · ${best.convLabel} · prioridad alta` });
    const r = await measureVariant({ filter: best.filter, conv: best.convFilter, enc, fps: F, gpu: 'high' });
    results.push({ ...best, gpu: 'high', ...r });
  }
  const ranked = [...results].sort((a, b) => b.fps - a.fps);
  let pick = ranked[0];
  const high = results.find((r) => r.gpu === 'high');
  if (high && pick && high.fps >= pick.fps * 0.9) pick = high;
  return {
    target: F,
    results: results.map(({ method, label, conv, convLabel, gpu, fps, error }) => ({ method, label, conv, convLabel, gpu, fps, error })),
    best: pick ? { method: pick.method, conv: pick.conv, gpu: pick.gpu, fps: pick.fps } : null,
  };
}

// ---------------------------------------------------------------------------
// Sesión de captura
//
// Los segmentos se ubican en el reloj real (wStart/wEnd). Si Windows corta la captura
// (cambio de resolución o de modo de pantalla), se lanza una sesión nueva con el mismo
// tamaño de salida y la misma base de tiempo, y se conservan los segmentos anteriores:
// el búfer y la grabación siguen sin interrupción (solo queda una pausa breve).
// ---------------------------------------------------------------------------
class Capture extends EventEmitter {
  constructor() {
    super();
    this.settings = clone(DEFAULTS);
    this.tmpRoot = path.join(os.tmpdir(), 'fotograma-capture');
    this.session = null;
    this.old = [];            // sesiones anteriores (tras reconectar) cuyos segmentos se conservan
    this.lock = null;         // { key, size, base, nowUs }: fijo mientras la captura sigue viva
    this.bufferOn = false;
    this.rec = null;          // { startWall }
    this.holds = [];          // instantes (reloj real) que no se pueden borrar todavía
    this.busy = Promise.resolve();
    this.thumbDir = path.join(os.tmpdir(), 'fotograma-studio-cache', 'capture-thumbs');
    this.waiting = null;      // nombre de la ventana minimizada que se espera
    this.waitToken = 0;
    this.restarts = [];       // reconexiones automáticas recientes
    this.restartToken = 0;
    this.reconnecting = false;
    this.titles = [];
    this.marks = [];          // marcadores (reloj real)
  }

  // Cancela la espera de una ventana minimizada (al detener el búfer o la grabación).
  cancelWait() {
    if (this.waiting) this.waitToken++;
  }

  configure(settings) {
    this.settings = mergeDefaults(settings);
    this.applyLive();
  }

  // Volumen, silencio y nombres de pista en vivo, sin reiniciar la captura: FFmpeg acepta órdenes
  // por su entrada estándar ('c' + filtro, instante, orden y valor) y las pasa a "volume@vN".
  applyLive() {
    const ss = this.session;
    if (!ss || ss.exited || !ss.audioIds) return;
    const sources = ss.audioIds.map((id) => this.settings.audio.find((x) => x.id === id));
    sources.forEach((a, i) => {
      if (!a) return;
      const vol = sourceVolume(a);
      if (Math.abs(ss.vols[i] - vol) < 0.0005) return;
      ss.vols[i] = vol;
      try { ss.child.stdin.write(`cvolume@v${i} -1 volume ${vol.toFixed(3)}\n`); } catch { /* ignorar */ }
    });
    if (sources.every(Boolean)) this.titles = trackTitles(sources, ss.settings.separateTracks);
  }

  sessions() { return [...this.old, ...(this.session ? [this.session] : [])]; }

  // Segmentos de todas las sesiones, ordenados en el reloj real.
  allSegs() {
    const out = [];
    for (const ss of this.sessions()) {
      if (ss.minOffset == null) continue;
      for (const g of ss.segs) out.push({ file: path.join(ss.dir, g.name), wStart: g.start + ss.minOffset, wEnd: g.end + ss.minOffset });
    }
    return out.sort((a, b) => a.wStart - b.wStart);
  }

  status() {
    const ss = this.session;
    const now = Date.now() / 1000;
    const segs = this.allSegs();
    const avail = segs.length ? segs[segs.length - 1].wEnd - segs[0].wStart : 0;
    return {
      running: !!ss && ss.ready,
      starting: ((!!ss && !ss.ready) || !!this.waiting) && !this.reconnecting,
      reconnecting: this.reconnecting,
      waiting: this.waiting,
      buffer: this.bufferOn,
      bufferSec: this.settings.bufferSec,
      available: Math.max(0, Math.min(avail, this.settings.bufferSec)),
      recording: !!this.rec,
      paused: !!(this.rec && this.rec.pausedAt),
      recTime: this.rec ? recElapsed(this.rec, now) : 0,
      marks: this.marks.length,
      fps: ss ? ss.fps : 0,
      // Con los tics tipo OBS las repeticiones ocurren dentro de la captura: la cifra no sería real.
      realFps: ss && !ss.ticks && ss.realFps != null ? ss.realFps : null,
      method: ss ? (ss.settings.video.source === 'window' ? 'wgc' : ss.method) : null,
      drops: ss ? ss.drops : 0,
      speed: ss ? ss.speed : 0,
      encoder: ss ? ss.encoderLabel : '',
      tracks: this.titles,
      size: this.lock ? this.lock.size : null,
      diskBytes: this.sessions().reduce((n, x) => n + x.diskBytes, 0),
      stats: this.stats(ss),
    };
  }

  // Estadísticas como las de OBS: uso de la CPU, espacio libre, bitrate real, imágenes repetidas…
  stats(ss) {
    const now = Date.now();
    const c = os.cpus();
    let idle = 0, total = 0;
    for (const x of c) { for (const k of Object.keys(x.times)) total += x.times[k]; idle += x.times.idle; }
    if (!this.cpuLast || now - this.cpuLast.t >= 900) {
      if (this.cpuLast) this.cpuPct = Math.max(0, Math.min(100, Math.round(100 * (1 - (idle - this.cpuLast.idle) / Math.max(1, total - this.cpuLast.total)))));
      this.cpuLast = { t: now, idle, total };
    }
    if (!this.diskAt || now - this.diskAt > 5000) {
      this.diskAt = now;
      try {
        fs.mkdirSync(this.settings.folder, { recursive: true });
        const st = fs.statfsSync(this.settings.folder);
        this.diskFree = st.bavail * st.bsize;
      } catch { this.diskFree = null; }
    }
    let bitrate = null;
    if (ss && ss.segs.length >= 2) {
      const last = ss.segs.slice(-6);
      const dur = last[last.length - 1].end - last[0].start;
      if (dur > 0.5) bitrate = last.reduce((n, g) => n + g.bytes, 0) * 8 / dur;
    }
    return {
      cpu: this.cpuPct ?? null, cpus: c.length, diskFree: this.diskFree, bitrate,
      dupPct: ss && ss.dupPct != null ? ss.dupPct : null,
      uptime: ss ? (now - ss.started) / 1000 : 0,
      reconnects: this.restarts.length, gpuPriority: ss ? !!ss.gpuPriority : null, fullSpeed: ss ? !!ss.fullSpeed : null,
      frames: ss ? ss.frames || 0 : 0,
    };
  }

  async start() {
    if (this.session) return;
    const s = clone(this.settings);
    const caps = await captureCaps();
    let srcSize;
    if (s.video.source === 'window') {
      if (!s.video.window) throw new Error('Elige la ventana o el juego que quieres capturar.');
      // La ventana se busca cada vez: su identificador cambia al reabrir el programa.
      const name = s.video.window.exe.replace(/\.exe$/i, '');
      const find = async () => {
        const wins = await listWindows();
        return wins.find((x) => x.exe.toLowerCase() === s.video.window.exe.toLowerCase() && x.title === s.video.window.title)
          || wins.find((x) => x.exe.toLowerCase() === s.video.window.exe.toLowerCase());
      };
      let w = await find();
      if (!w) throw new Error(`«${name}» no está abierto. Ábrelo o elige otra ventana.`);
      // Una ventana minimizada no tiene imagen: Windows Graphics Capture arrancaría sin
      // tamaño válido. Se espera a que esté visible y con un tamaño normal (no una transición).
      const usable = (st) => !st.minimized && st.w >= 320 && st.h >= 240;
      let st = await windowState(w.hwnd);
      if (!usable(st)) {
        const token = ++this.waitToken;
        this.waiting = name;
        if (!this.reconnecting) this.emit('event', { type: 'info', message: `«${name}» está minimizado: la captura empezará sola en cuanto vuelvas a la ventana.` });
        this.emit('status');
        try {
          for (;;) {
            await new Promise((r) => setTimeout(r, 1500));
            if (token !== this.waitToken) throw Object.assign(new Error('Espera cancelada'), { cancelled: true });
            w = await find();
            if (!w) throw new Error(`«${name}» se cerró.`);
            if (usable(await windowState(w.hwnd))) break;
          }
          // Margen para que el juego termine de restaurarse (cambio de resolución, etc.).
          await new Promise((r) => setTimeout(r, 1200));
          st = await windowState(w.hwnd);
          if (!usable(st)) throw new Error(`«${name}» volvió a minimizarse. Inténtalo de nuevo desde el juego (${this.settings.hotkeys.buffer || 'atajo del búfer'}).`);
        } finally {
          this.waiting = null;
          this.emit('status');
        }
      }
      srcSize = { w: st.w & ~1, h: st.h & ~1 };
      s.video.window = { ...s.video.window, hwnd: w.hwnd, title: w.title };
    } else {
      if (!caps.ddagrab) throw new Error('Esta versión de FFmpeg no admite captura de pantalla por GPU (ddagrab).');
      srcSize = await monitorSize(s.video.monitor || 0);
    }

    // Tamaño de salida y base de tiempo fijos mientras la captura siga viva: si el juego
    // cambia de resolución, la imagen se adapta a este tamaño y los segmentos siguen siendo
    // compatibles entre sí (se pueden unir en un mismo clip).
    const key = JSON.stringify([s.video.source, s.video.method, s.video.conv, s.video.monitor, s.video.window && s.video.window.exe, s.video.resolution, s.video.fps,
      s.encoder, s.codec, s.quality, s.audioCodec, s.rate, s.bitrate, s.preset, s.mixLimiter, s.audioKbps, s.separateTracks, s.audio.map((a) => [a.id, a.device, a.enabled, a.offsetMs, a.fx || null])]);
    if (!this.lock || this.lock.key !== key) {
      this.dropOld();
      // Se graba siempre a la resolución nativa (lo más fluido: estirar en la GPU mientras se
      // juega costaba fotogramas) y, si se pidió otra, se estira al guardar el clip.
      const post = targetSize(s);
      this.lock = { key, size: srcSize, post: post && (post.w !== srcSize.w || post.h !== srcSize.h) ? post : null,
        base: os.uptime(), nowUs: Date.now() * 1000 };
    }
    s.video.size = this.lock.size;
    if (s.video.source === 'window') Object.assign(s.video.window, this.lock.size);

    const enc = resolveEncoder(s, caps);
    const conv = await pickPipeline(s, caps, enc);
    await fsp.mkdir(this.tmpRoot, { recursive: true });
    await this.cleanupStale();
    const dir = await fsp.mkdtemp(path.join(this.tmpRoot, 's-'));
    fs.writeFileSync(path.join(dir, 'owner'), String(process.pid));
    const { args, titles, ids, vols } = buildArgs(s, caps, enc, conv, { base: this.lock.base, nowUs: this.lock.nowUs, dir });
    this.titles = titles;
    const child = spawn(engine.bin.ffmpeg, args, { windowsHide: true });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* ignorar */ }
    const throttle = disablePowerThrottling(child.pid);
    const ss = this.session = {
      child, dir, segs: [], listPos: 0, listBuf: '', minOffset: null, ready: false, stopping: false,
      fps: 0, drops: 0, speed: 0, err: '', encoderLabel: `${enc.label} · ${enc.codec.toUpperCase()}`,
      diskBytes: 0, started: Date.now(), settings: clone(s), audioIds: ids, vols, ticks: !!videoSource(s, caps).ticks, method: s.video.source === 'monitor' ? monitorMethod(s, caps) : 'wgc',
    };
    let buf = '';
    const prog = {};
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        prog[line.slice(0, eq)] = line.slice(eq + 1);
        if (line.startsWith('progress=')) {
          ss.fps = Number(prog.fps) || 0;
          ss.drops = Number(prog.drop_frames) || 0;
          ss.speed = parseFloat(prog.speed) || 0;
          // Imágenes nuevas por segundo que entrega Windows (sin contar las repetidas para mantener los fps).
          const now = Date.now(), frames = Number(prog.frame) || 0, dups = Number(prog.dup_frames) || 0;
          if (ss.lastProg && now - ss.lastProg.t > 300) {
            const dt = (now - ss.lastProg.t) / 1000;
            const real = Math.max(0, (frames - ss.lastProg.frames) - (dups - ss.lastProg.dups)) / dt;
            ss.realFps = ss.realFps == null ? real : ss.realFps * 0.5 + real * 0.5;
            const df = frames - ss.lastProg.frames;
            if (df > 0) ss.dupPct = Math.max(0, Math.min(100, (100 * (dups - ss.lastProg.dups)) / df));
          }
          ss.frames = frames;
          if (!ss.lastProg || now - ss.lastProg.t > 300) ss.lastProg = { t: now, frames, dups };
        }
      }
    });
    child.stderr.on('data', (d) => { ss.err += d; if (ss.err.length > 20000) ss.err = ss.err.slice(-20000); });
    child.on('close', (code) => this.onExit(ss, code));
    child.on('error', (e) => { ss.err += e.message; });
    ss.poll = setInterval(() => this.pollSegments(ss), 100);
    // Espera al primer segmento (o a que falle).
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        // Una ventana que no cambia puede tardar en enviar imagen: basta con que el proceso siga vivo.
        // (Con la pantalla quieta tampoco llegan imágenes nuevas hasta que algo cambia.)
        const windowAlive = Date.now() - t0 > 2500;
        if (ss.segs.length || (windowAlive && !ss.exited)) { clearInterval(iv); ss.ready = true; resolve(); }
        else if (ss.exited) { clearInterval(iv); reject(new Error(lastLines(ss.err) || 'La captura se detuvo al iniciar.')); }
        else if (Date.now() - t0 > 20000) { clearInterval(iv); this.kill(ss); reject(new Error('La captura no respondió.')); }
      }, 100);
    });
    setGpuPriority(child.pid, this.settings.gpuPriority).then((ok) => { ss.gpuPriority = ok; });
    throttle.then((ok) => { ss.fullSpeed = ok; });
    this.reconnecting = false;
    // Por si los ajustes cambiaron mientras arrancaba.
    this.applyLive();
    this.writeRecFile();
    this.emit('status');
  }

  pollSegments(ss) {
    let fd;
    try {
      fd = fs.openSync(path.join(ss.dir, 'list.csv'), 'r');
      const size = fs.fstatSync(fd).size;
      if (size > ss.listPos) {
        const b = Buffer.alloc(size - ss.listPos);
        fs.readSync(fd, b, 0, b.length, ss.listPos);
        ss.listPos = size;
        ss.listBuf += b.toString('utf8');
        let i;
        while ((i = ss.listBuf.indexOf('\n')) >= 0) {
          const [name, a, z] = ss.listBuf.slice(0, i).trim().split(',');
          ss.listBuf = ss.listBuf.slice(i + 1);
          if (!name) continue;
          const seg = { name, start: Number(a), end: Number(z), wall: Date.now() / 1000 };
          try { seg.bytes = fs.statSync(path.join(ss.dir, name)).size; } catch { seg.bytes = 0; }
          ss.diskBytes += seg.bytes;
          const off = seg.wall - seg.end;
          ss.minOffset = ss.minOffset == null ? off : Math.min(ss.minOffset, off);
          ss.segs.push(seg);
          this.prune();
          this.checkSplit();
          this.emit('segment');
        }
      }
    } catch { /* la lista aún no existe */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  // Borra los segmentos que ya no hacen falta ni para el búfer ni para la grabación.
  prune() {
    const now = Date.now() / 1000;
    let keepFrom = Infinity;
    if (this.bufferOn) keepFrom = now - this.settings.bufferSec - 2 * SEG;
    if (this.rec) keepFrom = Math.min(keepFrom, this.rec.startWall - 1.5 * SEG);
    for (const h of this.holds) keepFrom = Math.min(keepFrom, h);
    if (keepFrom === Infinity) return;
    this.marks = this.marks.filter((t) => t >= keepFrom);
    for (const ss of this.sessions()) {
      if (ss.minOffset == null) continue;
      const min = ss === this.session ? 1 : 0;
      while (ss.segs.length > min && ss.segs[0].end + ss.minOffset < keepFrom) {
        const g = ss.segs.shift();
        ss.diskBytes -= g.bytes;
        fs.unlink(path.join(ss.dir, g.name), () => {});
      }
    }
    this.old = this.old.filter((o) => {
      if (o.segs.length) return true;
      fsp.rm(o.dir, { recursive: true, force: true }).catch(() => {});
      return false;
    });
  }

  // Descarta las sesiones anteriores (al detener o al cambiar los ajustes).
  dropOld() {
    for (const o of this.old) fsp.rm(o.dir, { recursive: true, force: true }).catch(() => {});
    this.old = [];
  }

  onExit(ss, code) {
    ss.exited = true;
    clearInterval(ss.poll);
    this.pollSegments(ss);
    if (this.session !== ss) {
      if (!ss.keepDir && !this.old.includes(ss)) fsp.rm(ss.dir, { recursive: true, force: true }).catch(() => {});
      this.emit('status');
      return;
    }
    this.session = null;
    if (!ss.stopping && ss.ready && (this.bufferOn || this.rec)) {
      // Windows corta la captura si el juego cambia de resolución o de modo de pantalla
      // (al entrar o salir de pantalla completa, Alt+Tab…): se reconecta sola conservando
      // el búfer y la grabación.
      if (ss.segs.length) this.old.push(ss);
      else fsp.rm(ss.dir, { recursive: true, force: true }).catch(() => {});
      if (this.canRestart()) {
        this.reconnecting = true;
        if (!this.toldReconnect || Date.now() - this.toldReconnect > 120000) {
          this.toldReconnect = Date.now();
          this.emit('event', { type: 'info', message: 'Cambio de resolución o de pantalla completa: la captura se reconecta sola y conserva el búfer.' });
        }
        this.autoRestart(1);
      } else {
        this.giveUp(`La captura se detuvo inesperadamente (código ${code}).\n${lastLines(ss.err)}`);
      }
      this.emit('status');
      return;
    }
    if (!ss.keepDir) fsp.rm(ss.dir, { recursive: true, force: true }).catch(() => {});
    this.emit('status');
  }

  kill(ss) { try { ss.child.kill(); } catch { /* ignorar */ } }

  // La pantalla cambió de resolución (p. ej. el juego entra en pantalla completa a 1440×1044).
  // Si el cambio se mantiene unos segundos, la captura adopta el tamaño nuevo: así no quedan
  // bordes negros. Lo grabado hasta ese momento se guarda.
  onDisplayChange() {
    clearTimeout(this.displayTimer);
    this.displayTimer = setTimeout(async () => {
      const ss = this.session;
      if (!ss || !this.lock || ss.settings.video.source !== 'monitor') return;
      let now;
      try { now = await monitorSize(ss.settings.video.monitor || 0); } catch { return; }
      if (now.w === this.lock.size.w && now.h === this.lock.size.h) return;
      this.relock().catch((e) => this.emit('event', { type: 'error', message: e.message }));
    }, 4000);
  }

  relock() {
    return this.queue(async () => {
      if (!this.session || (!this.bufferOn && !this.rec)) return;
      const rec = this.rec;
      if (rec) await this.saveRec(rec, Date.now() / 1000).catch(() => {});
      this.rec = null;
      this.restartToken++;
      await this.stop();
      this.dropOld();
      this.lock = null;
      this.emit('event', { type: 'info', message: 'La resolución de la pantalla cambió: la captura se ajustó al tamaño nuevo.' });
      await this.start();
      if (rec) this.rec = newRec(Date.now() / 1000);
      this.writeRecFile();
      this.emit('status');
    });
  }

  // Como máximo 12 reconexiones por minuto, para no quedar en bucle.
  canRestart() {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60000);
    if (this.restarts.length >= 12) return false;
    this.restarts.push(now);
    return true;
  }

  autoRestart(attempt) {
    const token = ++this.restartToken;
    setTimeout(() => {
      if (token !== this.restartToken) return;
      this.queue(async () => {
        if (token !== this.restartToken || this.session) return;
        if (!this.bufferOn && !this.rec) { this.reconnecting = false; this.emit('status'); return; }
        try {
          await this.start();
        } catch (e) {
          if (e.cancelled || token !== this.restartToken) return;
          // La pantalla puede tardar unos segundos en terminar de cambiar de modo.
          if (attempt < 8 && this.canRestart()) this.autoRestart(attempt + 1);
          else this.giveUp(`No se pudo reconectar la captura: ${e.message}`);
        }
      });
    }, Math.min(800 * attempt, 4000));
  }

  // Abandona tras un fallo definitivo: guarda lo grabado y deja todo detenido.
  giveUp(message) {
    this.emit('event', { type: 'error', message });
    const rec = this.rec;
    this.rec = null;
    this.bufferOn = false;
    this.reconnecting = false;
    this.writeRecFile();
    const done = () => { this.dropOld(); this.lock = null; this.emit('status'); };
    if (rec) this.saveRec(rec, Date.now() / 1000).catch(() => {}).finally(done);
    else done();
  }

  async stop() {
    const ss = this.session;
    if (!ss) return;
    ss.stopping = true;
    try { ss.child.stdin.write('q'); } catch { /* ignorar */ }
    await new Promise((r) => {
      if (ss.exited) return r();
      const t = setTimeout(() => { this.kill(ss); r(); }, 4000);
      ss.child.once('close', () => { clearTimeout(t); r(); });
    });
  }

  // Parada completa: sin reconexiones pendientes ni sesiones guardadas.
  async stopAll() {
    this.restartToken++;
    this.reconnecting = false;
    await this.stop();
    this.dropOld();
    this.lock = null;
  }

  // Borra las carpetas temporales abandonadas. Nunca las de otro proceso que siga vivo (cada
  // carpeta guarda el proceso dueño en "owner"): podría estar capturando en ellas.
  async cleanupStale() {
    const keep = new Set(this.sessions().map((x) => x.dir));
    try {
      for (const d of await fsp.readdir(this.tmpRoot)) {
        if (keep.has(path.join(this.tmpRoot, d))) continue;
        let owner = 0;
        try { owner = Number(fs.readFileSync(path.join(this.tmpRoot, d, 'owner'), 'utf8')); } catch { /* sin dueño */ }
        if (owner && owner !== process.pid && pidAlive(owner)) continue;
        await fsp.rm(path.join(this.tmpRoot, d), { recursive: true, force: true }).catch(() => {});
      }
    } catch { /* ignorar */ }
  }

  // Serializa las operaciones de inicio/parada.
  queue(fn) {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch(() => {});
    return p;
  }

  startBuffer() {
    return this.queue(async () => {
      this.bufferOn = true;
      if (this.reconnecting) { this.emit('status'); return; }
      try { await this.start(); } catch (e) {
        this.bufferOn = false;
        this.emit('status');
        if (!e.cancelled) throw e;
      }
      this.emit('status');
    });
  }

  stopBuffer() {
    if (!this.rec) { this.restartToken++; this.cancelWait(); }
    return this.queue(async () => {
      this.bufferOn = false;
      if (!this.rec) await this.stopAll();
      else this.prune();
      this.emit('status');
    });
  }

  startRecording() {
    return this.queue(async () => {
      if (this.rec) return;
      if (!this.reconnecting) {
        try { await this.start(); } catch (e) {
          if (e.cancelled) return;
          throw e;
        }
      }
      this.rec = newRec(Date.now() / 1000);
      this.writeRecFile();
      this.emit('status');
    });
  }

  // Pausa o reanuda la grabación (el búfer de repetición sigue funcionando). Devuelve si quedó en pausa.
  pauseRecording() {
    const rec = this.rec;
    if (!rec) throw new Error('No hay ninguna grabación en curso.');
    const now = Date.now() / 1000;
    if (rec.pausedAt) { rec.pauses.push([rec.pausedAt, now]); rec.pausedAt = null; } else rec.pausedAt = now;
    this.writeRecFile();
    this.emit('status');
    return !!rec.pausedAt;
  }

  // División automática (como OBS): cada N minutos se guarda un archivo y se sigue en otro, sin cortes.
  checkSplit() {
    const min = Number(this.settings.splitMin) || 0;
    const rec = this.rec;
    if (!rec || !min) return;
    const now = Date.now() / 1000;
    if (recElapsed(rec, now) < min * 60) return;
    this.rec = newRec(now, { cont: true, pausedAt: rec.pausedAt ? now : null });
    this.writeRecFile();
    const hold = rec.startWall - 1.5 * SEG;
    this.holds.push(hold);
    this.waitWall(now)
      .then(() => this.saveRec(rec, now, { split: true }))
      .catch((e) => this.emit('event', { type: 'error', message: e.message }))
      .finally(() => { this.holds = this.holds.filter((x) => x !== hold); });
  }

  // Guarda la grabación "rec" hasta "end" (reloj real) sin los tramos en pausa. Cada segmento va
  // al archivo donde cae su mitad (en las divisiones automáticas, para no repetir ni perder nada).
  saveRec(rec, end, { split = false } = {}) {
    const pauses = [...rec.pauses, ...(rec.pausedAt ? [[rec.pausedAt, end]] : [])];
    const mid = (g) => (g.wStart + g.wEnd) / 2;
    const inRange = (g) => (rec.cont ? mid(g) >= rec.startWall : g.wEnd > rec.startWall + 0.01)
      && (split ? mid(g) < end : g.wStart < end + 0.01);
    const runs = [];
    let cur = null;
    for (const g of this.allSegs().filter(inRange)) {
      if (pauses.some(([a, b]) => mid(g) >= a && mid(g) < b)) { cur = null; continue; }
      if (!cur) runs.push((cur = []));
      cur.push(g);
    }
    if (!runs.length) return Promise.reject(new Error('La grabación no contiene datos.'));
    return this.saveSegs(runs, 'Grabación', 'recording');
  }

  // Marcador en el instante actual (como en Medal): queda como capítulo en el clip o la grabación.
  addMark() {
    if (!this.session && !this.reconnecting) throw new Error('Inicia el búfer o la grabación para poner marcadores.');
    this.marks.push(Date.now() / 1000);
    this.emit('event', { type: 'mark', n: this.marks.length });
    this.emit('status');
  }

  // Captura de pantalla: con la captura en marcha se toma la imagen de este instante del propio
  // búfer (sin abrir otra captura que compita con el juego); si no, se hace una captura suelta.
  async screenshot() {
    const t = Date.now() / 1000;
    const live = !!(this.session && this.session.ready);
    const size = live ? this.lock && this.lock.post : targetSize(this.settings);
    const out = this.outputPath('Captura', 'png');
    const vf = [...(size ? [`scale=${size.w}:${size.h}:flags=bicubic,setsar=1`] : []), 'format=rgb24'];
    const hold = t - 3;
    this.holds.push(hold);
    try {
      let r;
      if (live) {
        await this.waitWall(t + 0.1, 4000);
        const segs = this.allSegs();
        const seg = segs.find((g) => g.wStart <= t && t < g.wEnd) || segs[segs.length - 1];
        if (!seg) throw new Error('Aún no hay imagen en el búfer.');
        const off = Math.max(0, Math.min(t - seg.wStart, seg.wEnd - seg.wStart - 0.05));
        // Si el instante exacto no tiene imagen (pantalla quieta), se toma la última del segmento.
        for (const pos of [['-ss', off.toFixed(3)], ['-sseof', '-0.3'], []]) {
          r = await run(['-hide_banner', '-loglevel', 'error', '-y', ...pos, '-i', seg.file, '-frames:v', '1', '-vf', vf.join(','), '-update', '1', out]);
          if (r.code === 0 && fs.statSync(out).size > 0) break;
        }
      } else {
        const v = this.settings.video;
        let src = `ddagrab=output_idx=${v.monitor || 0}:framerate=30:draw_mouse=${v.cursor ? 1 : 0}`;
        if (v.source === 'window' && v.window) {
          const w = (await listWindows()).find((x) => x.exe.toLowerCase() === v.window.exe.toLowerCase());
          if (!w) throw new Error(`«${v.window.exe.replace(/\.exe$/i, '')}» no está abierto.`);
          src = `gfxcapture=hwnd=${w.hwnd}:max_framerate=30:capture_cursor=${v.cursor ? 1 : 0}`;
        }
        r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${src},hwdownload,format=bgra`, '-frames:v', '1', '-vf', vf.join(','), '-update', '1', out], { timeout: 10000 });
      }
      if (r.code !== 0 || !fs.statSync(out).size) throw new Error(`No se pudo hacer la captura de pantalla.\n${lastLines(r.stderr)}`);
    } catch (e) {
      try { fs.unlinkSync(out); } catch { /* ignorar */ }
      throw e;
    } finally {
      this.holds = this.holds.filter((x) => x !== hold);
    }
    const item = { path: out, kind: 'shot', created: Date.now(), duration: 0, size: fs.statSync(out).size, thumb: out };
    this.emit('event', { type: 'shot-saved', item });
    return item;
  }

  // Archivo de control de la grabación en curso: si la aplicación se cierra de golpe, al volver a
  // abrirla se recupera lo grabado (ver recover).
  writeRecFile() {
    const f = path.join(this.tmpRoot, 'grabacion.json');
    try {
      if (!this.rec) { fs.rmSync(f, { force: true }); return; }
      fs.mkdirSync(this.tmpRoot, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ ...this.rec, titles: this.titles, post: this.lock && this.lock.post,
        pid: process.pid, dirs: this.sessions().map((x) => x.dir) }));
    } catch { /* ignorar */ }
  }

  // Recupera una grabación interrumpida por un cierre inesperado (cuelgue, apagón…): sus segmentos
  // siguen en la carpeta temporal. (Un MP4 de OBS sin cerrar no se puede abrir.)
  recover() {
    return this.queue(async () => {
      const f = path.join(this.tmpRoot, 'grabacion.json');
      let info;
      try { info = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
      // Si el proceso que grababa sigue vivo, no es un cierre inesperado.
      if (info && info.pid && info.pid !== process.pid && pidAlive(info.pid)) return null;
      try { fs.rmSync(f, { force: true }); } catch { /* ignorar */ }
      if (this.session || !info || !info.startWall) return null;
      const pauses = [...(info.pauses || []), ...(info.pausedAt ? [[info.pausedAt, Infinity]] : [])];
      // Cada segmento se ubica por la hora en que se terminó de escribir. Solo cuentan las
      // carpetas de esa grabación.
      const segs = [];
      for (const dir of info.dirs || fs.readdirSync(this.tmpRoot).map((d) => path.join(this.tmpRoot, d))) {
        let names;
        try { names = fs.readdirSync(dir).filter((n) => /^seg_\d+\.ts$/.test(n)); } catch { continue; }
        for (const n of names) {
          const st = fs.statSync(path.join(dir, n));
          segs.push({ file: path.join(dir, n), t: st.mtimeMs / 1000, bytes: st.size });
        }
      }
      segs.sort((a, b) => a.t - b.t);
      const runs = [];
      let cur = null;
      for (const g of segs) {
        if (g.t < info.startWall + 0.5 || !g.bytes) continue;
        if (pauses.some(([a, b]) => g.t > a + 0.5 && g.t <= b + 0.5)) { cur = null; continue; }
        if (!cur) runs.push((cur = []));
        cur.push(g);
      }
      if (!runs.length) return null;
      this.titles = info.titles || [];
      const item = await this.saveSegs(runs, 'Grabación recuperada', 'recording', { post: info.post || null, marks: false });
      this.emit('event', { type: 'info', message: `Se recuperó una grabación que quedó sin terminar: ${path.basename(item.path)}` });
      await this.cleanupStale();
      return item;
    });
  }

  stopRecording() {
    if (!this.bufferOn) { this.restartToken++; this.cancelWait(); }
    return this.queue(async () => {
      const rec = this.rec;
      if (!rec) return null;
      const end = Date.now() / 1000;
      this.rec = null;
      this.writeRecFile();
      const hold = rec.startWall - 1.5 * SEG;
      this.holds.push(hold);
      try {
        await this.waitWall(end);
        return await this.saveRec(rec, end);
      } finally {
        this.holds = this.holds.filter((x) => x !== hold);
        if (!this.bufferOn) await this.stopAll();
        this.emit('status');
      }
    });
  }

  // Espera a que la captura actual haya cerrado un segmento que llegue hasta "t" (reloj real).
  waitWall(t, timeout = 6000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        const ss = this.session;
        const last = ss && ss.minOffset != null ? ss.segs[ss.segs.length - 1] : null;
        if (last && last.end + ss.minOffset >= t - 0.05) return resolve();
        if (!ss && !this.reconnecting) return resolve();
        if (Date.now() - t0 > timeout) return resolve();
        setTimeout(check, 50);
      };
      check();
    });
  }

  // Guarda los últimos N segundos (más el margen posterior configurado).
  async saveClip(seconds, { silent = false } = {}) {
    if (!this.bufferOn || !(this.session || this.old.length)) throw new Error('El búfer de repetición no está activo.');
    // Un clip cada vez: mantener pulsado el atajo (Windows lo repite) o coincidir con la voz
    // lanzaba varios guardados a la vez sobre el mismo archivo y el clip salía corrupto.
    if (this.clipBusy || Date.now() - (this.lastClipAt || 0) < 2000) {
      throw Object.assign(new Error('Ya se está guardando un clip.'), { busy: true });
    }
    this.clipBusy = true;
    this.lastClipAt = Date.now();
    try {
      return await this.saveClipNow(seconds, { silent });
    } finally {
      this.clipBusy = false;
      this.lastClipAt = Date.now();
    }
  }

  async saveClipNow(seconds, { silent }) {
    const len = Math.max(5, Number(seconds) || this.settings.bufferSec);
    const tEnd = Date.now() / 1000 + Math.max(0, Number(this.settings.postRollSec) || 0);
    const hold = tEnd - len - SEG;
    this.holds.push(hold);
    if (!silent) this.emit('event', { type: 'clip-start', seconds: len });
    try {
      await this.waitWall(tEnd, (this.settings.postRollSec + 6) * 1000);
      const segs = this.allSegs().filter((x) => x.wEnd > tEnd - len + 0.01 && x.wStart < tEnd);
      if (!segs.length) throw new Error('Aún no hay suficiente vídeo en el búfer.');
      if (silent) {
        const out = this.outputPath('Clip');
        await this.remux([segs], out);
        return { path: out };
      }
      return await this.saveSegs([segs], 'Clip', 'clip');
    } finally {
      this.holds = this.holds.filter((x) => x !== hold);
    }
  }

  // runs: tramos continuos de segmentos (más de uno si la grabación tuvo pausas).
  async saveSegs(runs, prefix, kind, { post = this.lock && this.lock.post, marks = true } = {}) {
    const out = this.outputPath(prefix);
    // Marcadores que caen dentro, en segundos del archivo final.
    const times = [];
    if (marks) {
      let off = 0;
      for (const run of runs) {
        const a = run[0].wStart, z = run[run.length - 1].wEnd;
        for (const t of this.marks) if (t >= a && t <= z) times.push(off + t - a);
        off += z - a;
      }
    }
    const opts = { marks: times };
    if (!post) {
      await this.remux(runs, out, opts);
      return this.finish(out, kind, times);
    }
    const native = `${out}.nativo.mp4`;
    try {
      await this.remux(runs, native, opts);
      this.emit('event', { type: 'info', message: `Estirando a ${post.w}×${post.h}…` });
      await this.stretch(native, out, post);
    } catch (e) {
      try { fs.unlinkSync(out); } catch { /* ignorar */ }
      throw e;
    } finally {
      try { fs.unlinkSync(native); } catch { /* ignorar */ }
    }
    return this.finish(out, kind, times);
  }

  // Estira un clip grabado a la resolución pedida (16:9, como escalador.bat), en la GPU si se
  // puede: se decodifica, se escala y se codifica sin pasar por la CPU.
  async stretch(input, out, size) {
    const caps = await captureCaps();
    const enc = resolveEncoder(this.settings, caps);
    const q = Math.max(14, (Number(this.settings.quality) || 20) - 2);
    const encArgs = encoderArgs(enc, q, this.settings.video.fps, this.settings).filter((x, i, a) => x !== '-force_key_frames' && a[i - 1] !== '-force_key_frames');
    const ext = path.extname(out).slice(1).toLowerCase();
    const fmt = ext === 'mkv' ? ['-f', 'matroska'] : ['-movflags', '+faststart', '-f', ext === 'mov' ? 'mov' : 'mp4'];
    const tail = ['-aspect', '16:9', ...encArgs, '-c:a', 'copy', '-map_metadata', '0', ...fmt];
    const tries = [];
    if (enc.id === 'amf' && caps.vppAmf) tries.push(['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', `vpp_amf=w=${size.w}:h=${size.h}:format=nv12`]);
    if (enc.id === 'nvenc' && caps.scaleD3d11) tries.push(['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', `scale_d3d11=width=${size.w}:height=${size.h}:format=nv12`]);
    tries.push(['-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', `scale=${size.w}:${size.h}:flags=bicubic,setsar=1,format=${enc.id === 'x264' ? 'yuv420p' : 'nv12'}`]);
    const part = `${out}.part`;
    let lastErr = '';
    for (const t of tries) {
      // Prioridad baja (CPU y GPU): el búfer sigue capturando mientras tanto y no debe perder imágenes.
      const r = await run(['-hide_banner', '-loglevel', 'error', '-y', ...t, ...tail, part], { timeout: 30 * 60 * 1000, onSpawn: (p) => {
        try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignorar */ }
        setGpuPriority(p.pid, 'low');
      } });
      if (r.code === 0) { fs.renameSync(part, out); return; }
      lastErr = lastLines(r.stderr);
      try { fs.unlinkSync(part); } catch { /* ignorar */ }
    }
    throw new Error(`No se pudo estirar el vídeo.\n${lastErr}`);
  }

  outputPath(prefix, extOverride) {
    const dir = this.settings.folder;
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    const ext = extOverride || (['mkv', 'mov'].includes(this.settings.container) ? this.settings.container : 'mp4');
    // El nombre se reserva creando el archivo en exclusiva ('wx'): si dos guardados coinciden
    // en el mismo segundo, cada uno obtiene su propio nombre.
    for (let n = 1; ; n++) {
      const file = path.join(dir, `${prefix} ${stamp}${n > 1 ? ` (${n})` : ''}.${ext}`);
      try { fs.closeSync(fs.openSync(file, 'wx')); return file; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }

  // Une segmentos sin recodificar, enviándolos por la entrada estándar (sin límite de longitud).
  // Todas las sesiones comparten base de tiempo, así que las marcas siguen creciendo entre ellas.
  // Con varios tramos (pausas), cada uno se une por separado y luego se encadenan: el concat de
  // FFmpeg reajusta las marcas de tiempo y las pausas no dejan huecos.
  async remux(runs, out, { marks = [] } = {}) {
    const titles = this.titles;
    // Se analiza más contenido al empezar: con la pantalla quieta el vídeo puede tardar en aparecer.
    const probe = ['-analyzeduration', '30000000', '-probesize', '200000000'];
    const tmp = [];
    const ext = path.extname(out).slice(1).toLowerCase();
    const mp4 = ext === 'mp4' || ext === 'mov';
    const part = `${out}.part`;
    try {
      let input, files = [];
      if (runs.length === 1) {
        input = [...probe, '-f', 'mpegts', '-i', 'pipe:0'];
        files = runs[0].map((g) => g.file);
      } else {
        for (const [k, run] of runs.entries()) {
          const f = `${out}.tramo${k}.ts`;
          tmp.push(f);
          await pipeSegs(run.map((g) => g.file), ['-hide_banner', '-loglevel', 'error', '-y', ...probe, '-f', 'mpegts', '-i', 'pipe:0', '-map', '0', '-c', 'copy', '-f', 'mpegts', f]);
        }
        const list = `${out}.tramos.txt`;
        fs.writeFileSync(list, tmp.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
        tmp.push(list);
        input = [...probe, '-f', 'concat', '-safe', '0', '-i', list];
      }
      const args = ['-hide_banner', '-loglevel', 'error', '-y', ...input];
      if (marks.length) {
        const dur = runs.reduce((n, r) => n + r[r.length - 1].wEnd - r[0].wStart, 0);
        const meta = `${out}.capitulos.txt`;
        fs.writeFileSync(meta, chaptersMeta(marks, dur));
        tmp.push(meta);
        args.push('-f', 'ffmetadata', '-i', meta, '-map_chapters', '1');
      }
      args.push('-map', '0', '-c', 'copy');
      titles.forEach((t, i) => {
        args.push(`-metadata:s:a:${i}`, `title=${t}`, `-metadata:s:a:${i}`, `handler_name=${t}`, `-disposition:a:${i}`, i === 0 ? 'default' : '0');
      });
      if (mp4) args.push('-movflags', '+faststart');
      args.push('-f', ext === 'mov' ? 'mov' : mp4 ? 'mp4' : 'matroska', part);
      await pipeSegs(files, args);
      fs.renameSync(part, out);
    } catch (e) {
      for (const f of [part, out]) { try { fs.unlinkSync(f); } catch { /* ignorar */ } }
      throw e;
    } finally {
      for (const f of tmp) { try { fs.unlinkSync(f); } catch { /* ignorar */ } }
    }
  }

  async finish(file, kind, markers = []) {
    const st = fs.statSync(file);
    let duration = 0;
    try { duration = (await engine.probe(file)).duration; } catch { /* ignorar */ }
    let thumb = null;
    try {
      fs.mkdirSync(this.thumbDir, { recursive: true });
      thumb = path.join(this.thumbDir, `${path.basename(file).replace(/\.[^.]+$/, '')}-${Math.floor(st.mtimeMs).toString(36)}.jpg`);
      const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(1, duration / 2)), '-i', file,
        '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', thumb], { timeout: 15000 });
      if (r.code !== 0) thumb = null;
    } catch { thumb = null; }
    const item = { path: file, kind, created: Date.now(), duration, size: st.size, thumb, markers };
    this.emit('event', { type: kind === 'clip' ? 'clip-saved' : 'recording-saved', item });
    return item;
  }

  /**
   * Mide el retraso real de cada fuente de audio: una ventanita parpadea a la vez que
   * suenan pitidos; se graba y se compara cuándo aparece cada destello y cada pitido.
   * opts = { monitor, rect: { x, y, w, h } (píxeles del monitor), flash: () => Promise, tmpDir }
   */
  async calibrate({ monitor, rect, flash, tmpDir }) {
    if (this.session) throw new Error('Detén el búfer y la grabación antes de calibrar.');
    const saved = this.settings;
    const sources = (saved.audio || []).filter((a) => a.enabled !== false && a.device);
    if (!sources.length) throw new Error('Añade al menos una fuente de audio.');
    await fsp.mkdir(tmpDir, { recursive: true });
    this.settings = {
      ...clone(saved), folder: tmpDir, container: 'mp4', bufferSec: 30, postRollSec: 0, separateTracks: true,
      video: { ...saved.video, source: 'monitor', monitor, resolution: 'native', fps: 60, cursor: false },
      audio: sources.map((a) => ({ ...a, offsetMs: 0, muted: false, volume: 1 })),
    };
    try {
      this.bufferOn = true;
      await this.start();
      await new Promise((r) => setTimeout(r, 700));
      await flash();
      await new Promise((r) => setTimeout(r, 700));
      const clip = await this.saveClip(16, { silent: true });
      this.bufferOn = false;
      await this.stopAll();
      return await this.analyzeCalibration(clip.path, rect, sources, tmpDir);
    } finally {
      this.bufferOn = false;
      await this.stopAll();
      this.settings = saved;
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async analyzeCalibration(file, rect, sources, dir) {
    const r = await run(['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-vf',
      `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=yavg.txt`, '-f', 'null', '-'], { cwd: dir, timeout: 60000 });
    if (r.code !== 0) throw new Error(`No se pudo analizar la calibración.\n${lastLines(r.stderr)}`);
    const series = (txt, key) => {
      const out = [];
      let t = 0;
      for (const line of txt.split(/\r?\n/)) {
        const m = /pts_time:([\d.]+)/.exec(line);
        if (m) t = Number(m[1]);
        const v = new RegExp(`${key}=(-?[\\d.]+|-inf)`).exec(line);
        if (v) out.push([t, v[1] === '-inf' ? -120 : Number(v[1])]);
      }
      return out;
    };
    const y = series(fs.readFileSync(path.join(dir, 'yavg.txt'), 'utf8'), 'lavfi.signalstats.YAVG');
    const lo = Math.min(...y.map((p) => p[1])), hi = Math.max(...y.map((p) => p[1]));
    if (!y.length || hi - lo < 60) throw new Error('No se detectaron los destellos. ¿Está la ventana de calibración en la pantalla capturada?');
    const mid = (lo + hi) / 2;
    const flashes = [];
    for (let i = 1; i < y.length; i++) if (y[i][1] > mid && y[i - 1][1] <= mid) flashes.push(y[i][0]);
    const results = [];
    const multi = sources.length > 1;
    for (let k = 0; k < sources.length; k++) {
      const name = `a${k}.txt`;
      await run(['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:a:${multi ? k + 1 : 0}`, '-af',
        `asetnsamples=n=240,bandpass=f=2000:width_type=q:width=6,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${name}`,
        '-f', 'null', '-'], { cwd: dir, timeout: 60000 });
      let a = [];
      try { a = series(fs.readFileSync(path.join(dir, name), 'utf8'), 'lavfi.astats.Overall.RMS_level'); } catch { /* sin datos */ }
      const lags = [];
      for (const v of flashes) {
        const before = a.filter((p) => p[0] > v - 0.45 && p[0] < v - 0.15).map((p) => p[1]).sort((m, n) => m - n);
        const base = before.length ? before[before.length >> 1] : -90;
        const hit = a.find((p) => p[0] > v - 0.15 && p[0] < v + 0.45 && p[1] > Math.max(base + 12, -55));
        if (hit) lags.push(hit[0] - v);
      }
      lags.sort((m, n) => m - n);
      const ok = lags.length >= 3;
      results.push({ id: sources[k].id, device: sources[k].device, label: sources[k].label, hits: lags.length, flashes: flashes.length,
        lagMs: ok ? Math.round(lags[lags.length >> 1] * 1000) : null });
    }
    return results;
  }

  async shutdown() {
    this.waitToken++;
    this.bufferOn = false;
    if (this.rec) { try { await this.stopRecording(); } catch { /* ignorar */ } }
    await this.stopAll();
  }
}

module.exports = { setEncoderPreference, buildArgs, convVariants, monitorMethod, benchmark, isMinimized, windowState, Capture, DEFAULTS, RESOLUTIONS, mergeDefaults, listAudioDevices, listMonitors, listWindows, captureCaps, resolveEncoder, pickPipeline };
