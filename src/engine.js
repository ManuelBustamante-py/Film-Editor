'use strict';
/*
 * Motor de vídeo basado en FFmpeg: análisis de archivos, miniaturas, formas de
 * onda, proxies de previsualización y exportación (unir, recortar, velocidad,
 * color, fotogramas, compresión por tamaño objetivo, etc.).
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const Core = require('./shared/core');

const bin = { ffmpeg: null, ffprobe: null, version: '', newScriptSyntax: true };
let cacheDir = path.join(os.tmpdir(), 'fotograma-studio-cache');
let capsCache = null;

function works(cmd) {
  try {
    return spawnSync(cmd, ['-version'], { windowsHide: true, timeout: 8000 }).status === 0;
  } catch {
    return false;
  }
}

function bundled(mod) {
  try {
    let p = require(mod);
    if (p && typeof p === 'object') p = p.path;
    return p ? p.replace('app.asar', 'app.asar.unpacked') : null;
  } catch {
    return null;
  }
}

// FFmpeg moderno incluido con la aplicación (vendor/ffmpeg; en el instalador, resources/ffmpeg).
// Así la captura funciona igual en cualquier equipo, aunque no tenga FFmpeg instalado.
function vendored(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg'), path.join(__dirname, '..', 'vendor', 'ffmpeg')];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function init(opts = {}) {
  if (opts.cacheDir) cacheDir = opts.cacheDir;
  fs.mkdirSync(cacheDir, { recursive: true });
  // Orden: el incluido con la aplicación, el del sistema y, por último, el de ffmpeg-static.
  bin.ffmpeg = process.env.FOTOGRAMA_FFMPEG || vendored('ffmpeg') || (works('ffmpeg') ? 'ffmpeg' : bundled('ffmpeg-static'));
  bin.ffprobe = process.env.FOTOGRAMA_FFPROBE || vendored('ffprobe') || (works('ffprobe') ? 'ffprobe' : bundled('ffprobe-static'));
  if (!bin.ffmpeg || !bin.ffprobe) throw new Error('No se encontró FFmpeg. Instálalo o ejecuta "npm install".');
  const v = spawnSync(bin.ffmpeg, ['-hide_banner', '-version'], { windowsHide: true, encoding: 'utf8' });
  const m = /ffmpeg version (\S+)/.exec(v.stdout || '');
  bin.version = m ? m[1] : 'desconocida';
  const major = /^n?(\d+)\./.exec(bin.version);
  bin.newScriptSyntax = major ? Number(major[1]) >= 7 : true;
  return { ...bin };
}

const fileUrl = (p) => pathToFileURL(p).href;
// Protocolo propio servido por main.js (admite rangos y CORS, necesario para Web Audio).
const mediaUrl = (p) => `media://local/${encodeURIComponent(p)}`;
const exists = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;

function cleanError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-6).join('\n');
}

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 30000) err = err.slice(-30000);
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve({ stdout: out, stderr: err }) : reject(new Error(cleanError(err) || `El proceso terminó con código ${code}`)));
  });
}

// Ejecuta FFmpeg informando del progreso. Devuelve { promise, cancel }.
function runFfmpeg(args, { cwd, duration, onProgress } = {}) {
  let child, cancelled = false;
  const promise = new Promise((resolve, reject) => {
    child = spawn(bin.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args], {
      cwd, windowsHide: true,
    });
    let buf = '', err = '';
    const st = {};
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq), v = line.slice(eq + 1);
        st[k] = v;
        if (k === 'progress' && onProgress) {
          const us = Number(st.out_time_us !== undefined ? st.out_time_us : st.out_time_ms);
          const t = Number.isFinite(us) && us > 0 ? us / 1e6 : 0;
          onProgress({
            time: t,
            pct: duration ? Math.min(1, t / duration) : 0,
            fps: Number(st.fps) || 0,
            speed: parseFloat(st.speed) || 0,
            done: v === 'end',
          });
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 30000) err = err.slice(-30000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (cancelled) reject(Object.assign(new Error('Cancelado por el usuario'), { cancelled: true }));
      else if (code === 0) resolve();
      else reject(new Error(cleanError(err) || `FFmpeg terminó con código ${code}`));
    });
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      try { child && child.kill('SIGKILL'); } catch { /* ya terminado */ }
    },
  };
}

// Limita la concurrencia de tareas pesadas (miniaturas, ondas, proxies).
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const heavy = limiter(2);

function cacheKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Análisis
// ---------------------------------------------------------------------------
const PLAYABLE_V = ['h264', 'vp8', 'vp9', 'av1', 'hevc'];
const PLAYABLE_A = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
const PROXY_EXT = ['.avi', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.vob', '.3gp', '.mxf', '.asf', '.divx'];

async function probe(file) {
  const { stdout } = await run(bin.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new Error('El archivo no contiene pistas de vídeo ni de audio.');
  if (!v) {
    const tags = j.format.tags || {};
    return {
      kind: 'audio', path: file, name: path.basename(file), url: mediaUrl(file),
      width: 0, height: 0, fps: 0, fpsStr: '0', duration: Number(j.format.duration) || Number(a.duration) || 0,
      size: Number(j.format.size) || fs.statSync(file).size, bitrate: Number(j.format.bit_rate) || 0,
      vcodec: null, acodec: a.codec_name, hasAudio: true, sampleRate: Number(a.sample_rate) || 0,
      channels: a.channels || 2, title: tags.title || tags.TITLE || null, artist: tags.artist || tags.ARTIST || null,
      needsProxy: false,
    };
  }

  let rot = 0;
  const sd = (v.side_data_list || []).find((d) => d.rotation !== undefined);
  if (sd) rot = Number(sd.rotation) || 0;
  else if (v.tags && v.tags.rotate) rot = Number(v.tags.rotate) || 0;
  rot = (((Math.round(rot / 90) * 90) % 360) + 360) % 360;

  let sar = 1;
  if (v.sample_aspect_ratio && /^\d+:\d+$/.test(v.sample_aspect_ratio)) {
    const [n, d] = v.sample_aspect_ratio.split(':').map(Number);
    if (n && d) sar = n / d;
  }
  let w = Math.round(v.width * sar), h = v.height;
  if (rot === 90 || rot === 270) [w, h] = [h, w];

  let fpsStr = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
  let fps = Core.parseFps(fpsStr);
  if (!(fps > 0 && fps <= 480)) { fpsStr = '30'; fps = 30; }
  // Simplifica fracciones habituales (p. ej. 60/1 → 60).
  if (/^\d+\/1$/.test(fpsStr)) fpsStr = fpsStr.split('/')[0];

  const duration = Number(j.format.duration) || Number(v.duration) || 0;
  const size = Number(j.format.size) || fs.statSync(file).size;
  const ext = path.extname(file).toLowerCase();
  const vcodec = v.codec_name;
  const acodec = a ? a.codec_name : null;
  const needsProxy = PROXY_EXT.includes(ext) || !PLAYABLE_V.includes(vcodec) || (acodec && !PLAYABLE_A.includes(acodec));

  return {
    kind: 'video',
    path: file,
    name: path.basename(file),
    url: mediaUrl(file),
    width: w, height: h, codedWidth: v.width, codedHeight: v.height, sar, rotation: rot,
    fps, fpsStr, duration, size,
    bitrate: Number(j.format.bit_rate) || 0,
    vcodec, acodec, hasAudio: !!a,
    pixFmt: v.pix_fmt, container: j.format.format_name,
    needsProxy,
    audioTracks: audioTracksOf(streams),
  };
}

// Pistas de audio con su nombre (las grabaciones guardan una pista por fuente).
function audioTracksOf(streams) {
  const generic = /^(SoundHandler|Sound Media Handler|ISO Media file produced by.*|)$/i;
  return streams.filter((s) => s.codec_type === 'audio').map((s, i) => {
    const t = s.tags || {};
    const name = [t.title, t.name, t.handler_name].find((x) => x && !generic.test(x));
    return { i, name: name || `Pista ${i + 1}`, codec: s.codec_name, channels: s.channels || 2 };
  });
}

// ---------------------------------------------------------------------------
// Miniaturas, forma de onda y proxies
// ---------------------------------------------------------------------------
function thumbnails(file, info) {
  if (info.kind === 'audio') return Promise.resolve(null);
  return heavy(async () => {
    const key = cacheKey(file);
    const poster = path.join(cacheDir, `${key}_poster.jpg`);
    const tiles = Math.max(6, Math.min(30, Math.ceil(info.duration / 3)));
    const strip = path.join(cacheDir, `${key}_strip${tiles}.jpg`);
    if (!exists(poster)) {
      const at = Math.min(1, info.duration / 3);
      await run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', file,
        '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', poster]);
    }
    if (!exists(strip)) {
      const rate = tiles / Math.max(info.duration, 0.1);
      try {
        await run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-skip_frame', 'nokey', '-i', file, '-an',
          '-vf', `fps=${rate.toFixed(6)},scale=160:90:force_original_aspect_ratio=increase,crop=160:90,tile=${tiles}x1`,
          '-frames:v', '1', '-q:v', '5', strip]);
      } catch {
        // Algunos códecs no admiten -skip_frame; se decodifica todo.
        await run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-an',
          '-vf', `fps=${rate.toFixed(6)},scale=160:90:force_original_aspect_ratio=increase,crop=160:90,tile=${tiles}x1`,
          '-frames:v', '1', '-q:v', '5', strip]);
      }
    }
    return { poster: fileUrl(poster), strip: exists(strip) ? fileUrl(strip) : null, tiles };
  });
}

function waveform(file) {
  return heavy(async () => {
    const out = path.join(cacheDir, `${cacheKey(file)}_wave.png`);
    if (!exists(out)) {
      await run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-filter_complex',
        'aformat=channel_layouts=mono,showwavespic=s=2000x120:colors=0x2dd4bf:scale=sqrt', '-frames:v', '1', out]);
    }
    return fileUrl(out);
  });
}

const proxyJobs = new Map();
function proxy(file, info, onProgress) {
  const key = cacheKey(file);
  if (proxyJobs.has(key)) return proxyJobs.get(key);
  const out = path.join(cacheDir, `${key}_proxy.mp4`);
  const job = heavy(async () => {
    if (exists(out)) return mediaUrl(out);
    const part = out.replace(/\.mp4$/, '.part.mp4');
    const args = ['-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:min(720\\,ih)',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-g', '12', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', part];
    await runFfmpeg(args, { duration: info.duration, onProgress }).promise;
    await fsp.rename(part, out);
    return mediaUrl(out);
  }).finally(() => proxyJobs.delete(key));
  proxyJobs.set(key, job);
  return job;
}

// ---------------------------------------------------------------------------
// Capacidades (códecs disponibles y aceleración por GPU)
// ---------------------------------------------------------------------------
async function testEncoder(enc) {
  try {
    await run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
      '-frames:v', '3', '-c:v', enc, '-f', 'null', '-']);
    return true;
  } catch {
    return false;
  }
}

async function capabilities() {
  if (capsCache) return capsCache;
  const { stdout } = await run(bin.ffmpeg, ['-hide_banner', '-encoders']);
  const has = (n) => new RegExp(`\\s${n}\\s`).test(stdout);
  const caps = {
    ffmpeg: bin.ffmpeg, version: bin.version,
    sw: {
      h264: has('libx264'), h265: has('libx265'), vp9: has('libvpx-vp9'),
      av1: has('libsvtav1') ? 'libsvtav1' : has('libaom-av1') ? 'libaom-av1' : null,
      prores: has('prores_ks'), opus: has('libopus'),
    },
    hw: {},
  };
  const vendors = [
    ['nvenc', 'NVIDIA NVENC', 'h264_nvenc', 'hevc_nvenc'],
    ['qsv', 'Intel Quick Sync', 'h264_qsv', 'hevc_qsv'],
    ['amf', 'AMD AMF', 'h264_amf', 'hevc_amf'],
  ];
  await Promise.all(vendors.map(async ([id, label, e264, e265]) => {
    if (!has(e264) || !(await testEncoder(e264))) return;
    caps.hw[id] = { label, h264: e264, h265: has(e265) && (await testEncoder(e265)) ? e265 : null };
  }));
  capsCache = caps;
  return caps;
}

// ---------------------------------------------------------------------------
// Exportación
// ---------------------------------------------------------------------------
const num = Core.num;

function atempoChain(speed) {
  const f = [];
  let s = speed;
  while (s > 2) { f.push('atempo=2'); s /= 2; }
  while (s < 0.5) { f.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) f.push(`atempo=${num(s, 6)}`);
  return f;
}

function pixFmtFor(codec) {
  return codec === 'prores' ? 'yuv422p10le' : 'yuv420p';
}

function videoChain(c, i, plan, s) {
  const f = [];
  const speed = c.speed || 1;
  const D = Core.clipDuration(c);
  const W = plan.width, H = plan.height;
  f.push(`setpts=(PTS-STARTPTS)/${num(speed, 6)}`);
  if (c.sar && Math.abs(c.sar - 1) > 1e-3) f.push('scale=trunc(iw*sar/2)*2:ih', 'setsar=1');
  if (c.flipH) f.push('hflip');
  if (c.flipV) f.push('vflip');
  const r = (((c.rotate || 0) % 360) + 360) % 360;
  if (r === 90) f.push('transpose=clock');
  else if (r === 180) f.push('hflip', 'vflip');
  else if (r === 270) f.push('transpose=cclock');
  const cr = c.crop;
  if (cr && (cr.x > 0.0005 || cr.y > 0.0005 || cr.w < 0.9995 || cr.h < 0.9995))
    f.push(`crop=trunc(iw*${num(cr.w, 6)}/2)*2:trunc(ih*${num(cr.h, 6)}/2)*2:trunc(iw*${num(cr.x, 6)}):trunc(ih*${num(cr.y, 6)})`);
  if (s.fit === 'cover') f.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${W}:${H}`);
  else f.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`);
  f.push(...Core.ffmpegColorFilters(c.color));
  if (s.fit !== 'cover') f.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
  f.push('setsar=1', `format=${pixFmtFor(plan.codec)}`);
  if (s.fpsMode === 'mci') f.push(`minterpolate=fps=${plan.fpsStr}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
  else if (s.fpsMode === 'blend') f.push(`framerate=fps=${plan.fpsStr}`);
  // fps al final fija una cadencia constante exacta (framerate/minterpolate pueden dejar huecos al inicio).
  f.push(`fps=${plan.fpsStr}`);
  // Garantiza la duración exacta del segmento para que audio y vídeo no se desfasen.
  f.push('tpad=stop_mode=clone:stop_duration=2', `trim=duration=${num(D, 6)}`, 'setpts=PTS-STARTPTS');
  if (c.fadeIn > 0) f.push(`fade=t=in:st=0:d=${num(Math.min(c.fadeIn, D), 3)}`);
  if (c.fadeOut > 0) f.push(`fade=t=out:st=${num(Math.max(0, D - c.fadeOut), 3)}:d=${num(Math.min(c.fadeOut, D), 3)}`);
  return `[${i}:v:0]${f.join(',')}[v${i}]`;
}

function audioChain(c, i) {
  const D = Core.clipDuration(c);
  const f = [];
  if (c.hasAudio) {
    f.push('asetpts=PTS-STARTPTS', ...atempoChain(c.speed || 1));
    const vol = c.muted ? 0 : c.volume == null ? 1 : c.volume;
    if (Math.abs(vol - 1) > 1e-3) f.push(`volume=${num(vol, 3)}`);
  }
  f.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'apad', `atrim=duration=${num(D, 6)}`);
  if (c.fadeIn > 0) f.push(`afade=t=in:st=0:d=${num(Math.min(c.fadeIn, D), 3)}`);
  if (c.fadeOut > 0) f.push(`afade=t=out:st=${num(Math.max(0, D - c.fadeOut), 3)}:d=${num(Math.min(c.fadeOut, D), 3)}`);
  return c.hasAudio ? `[${i}:a:0]${f.join(',')}[a${i}]` : `anullsrc=r=48000:cl=stereo,${f.join(',')}[a${i}]`;
}

function musicChain(a, inputIndex, k) {
  const D = a.out - a.in;
  const f = ['asetpts=PTS-STARTPTS'];
  if (Math.abs(a.volume - 1) > 1e-3) f.push(`volume=${num(a.volume, 3)}`);
  f.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
  if (a.fadeIn > 0) f.push(`afade=t=in:st=0:d=${num(Math.min(a.fadeIn, D), 3)}`);
  if (a.fadeOut > 0) f.push(`afade=t=out:st=${num(Math.max(0, D - a.fadeOut), 3)}:d=${num(Math.min(a.fadeOut, D), 3)}`);
  const ms = Math.round(a.start * 1000);
  if (ms > 0) f.push(`adelay=${ms}:all=1`);
  return `[${inputIndex}:a:0]${f.join(',')}[m${k}]`;
}

/**
 * job = { clips, texts?, audios? }
 *  - texts:  [{ file, start, duration, fadeIn, fadeOut }] (PNG a resolución de salida)
 *  - audios: [{ path, start, in, out, volume, fadeIn, fadeOut }]
 * Índices de entrada: clips, después textos, después audios.
 */
function buildGraph(job, plan, s, withAudio) {
  const clips = job.clips, texts = job.texts || [], audios = withAudio ? job.audios || [] : [];
  const layout = Core.sequenceLayout(clips);
  const parts = [];
  clips.forEach((c, i) => {
    // settb iguala la base de tiempo de todos los segmentos (lo exige xfade).
    parts.push(videoChain(c, i, plan, s).replace(/\[v(\d+)\]$/, ',settb=AVTB[v$1]'));
    if (withAudio) parts.push(audioChain(c, i));
  });

  let cv, ca;
  if (!layout.items.some((it) => it.tIn > 0)) {
    const ins = clips.map((_, i) => (withAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
    parts.push(`${ins}concat=n=${clips.length}:v=1:a=${withAudio ? 1 : 0}[vseq]${withAudio ? '[aseq]' : ''}`);
    cv = 'vseq';
    ca = 'aseq';
  } else {
    cv = 'v0';
    ca = 'a0';
    let len = layout.items[0].dur;
    for (let i = 1; i < clips.length; i++) {
      const it = layout.items[i];
      if (it.tIn > 0) {
        parts.push(`[${cv}][v${i}]xfade=transition=${it.transIn}:duration=${num(it.tIn, 6)}:offset=${num(len - it.tIn, 6)},settb=AVTB[xv${i}]`);
        if (withAudio) parts.push(`[${ca}][a${i}]acrossfade=d=${num(it.tIn, 6)}[xa${i}]`);
      } else {
        parts.push(`[${cv}][v${i}]concat=n=2:v=1:a=0,settb=AVTB[xv${i}]`);
        if (withAudio) parts.push(`[${ca}][a${i}]concat=n=2:v=0:a=1[xa${i}]`);
      }
      len += it.dur - it.tIn;
      cv = `xv${i}`;
      ca = `xa${i}`;
    }
  }

  texts.forEach((t, k) => {
    const idx = clips.length + k;
    const f = ['format=rgba'];
    if (t.fadeIn > 0) f.push(`fade=t=in:st=0:d=${num(Math.min(t.fadeIn, t.duration), 3)}:alpha=1`);
    if (t.fadeOut > 0) f.push(`fade=t=out:st=${num(Math.max(0, t.duration - t.fadeOut), 3)}:d=${num(Math.min(t.fadeOut, t.duration), 3)}:alpha=1`);
    f.push(`setpts=PTS-STARTPTS+${num(t.start, 6)}/TB`);
    parts.push(`[${idx}:v]${f.join(',')}[tx${k}]`);
    parts.push(`[${cv}][tx${k}]overlay=0:0:eof_action=pass:enable='between(t,${num(t.start, 4)},${num(t.start + t.duration, 4)})'[ov${k}]`);
    cv = `ov${k}`;
  });
  parts.push(`[${cv}]fps=${plan.fpsStr},format=${pixFmtFor(plan.codec)}[vout]`);

  if (withAudio) {
    if (audios.length) {
      audios.forEach((a, k) => parts.push(musicChain(a, clips.length + texts.length + k, k)));
      parts.push(`[${ca}]${audios.map((_, k) => `[m${k}]`).join('')}amix=inputs=${audios.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
    } else parts.push(`[${ca}]anull[aout]`);
  }
  return parts.join(';\n');
}

// Orden de preferencia de los codificadores por GPU (la tarjeta dedicada primero); lo fija
// la detección del equipo al arrancar (src/system.js).
let hwOrder = ['nvenc', 'amf', 'qsv'];
function setHwPreference(list) {
  if (Array.isArray(list) && list.length) hwOrder = [...new Set([...list, 'nvenc', 'amf', 'qsv'])];
}

function resolveEncoder(s, caps) {
  // Automático: la GPU para calidad o bitrate (mucho más rápida); la CPU cuando hay que clavar
  // un tamaño, porque solo ella hace dos pasadas.
  if (s.hw === 'auto') {
    const id = (s.codec === 'h264' || s.codec === 'h265') && (s.rateMode === 'crf' || s.rateMode === 'bitrate')
      ? hwOrder.find((x) => caps.hw[x] && caps.hw[x][s.codec]) : null;
    if (id) return { hw: id, name: caps.hw[id][s.codec] };
  } else if ((s.codec === 'h264' || s.codec === 'h265') && s.hw && s.hw !== 'none' && caps.hw[s.hw] && caps.hw[s.hw][s.codec]) {
    return { hw: s.hw, name: caps.hw[s.hw][s.codec] };
  }
  const sw = { h264: 'libx264', h265: 'libx265', vp9: 'libvpx-vp9', av1: caps.sw.av1 || 'libsvtav1', prores: 'prores_ks' };
  return { hw: null, name: sw[s.codec] };
}

const k = (v) => `${Math.max(1, Math.round(v))}k`;

function videoArgs(s, plan, enc, pass) {
  const mode = plan.rateMode;
  const kb = plan.videoKbps;
  const preset = s.preset || 'medium';
  const mp4ish = s.container === 'mp4' || s.container === 'mov';
  const vbv = mode === 'bitrate' ? ['-maxrate', k(kb * 1.5), '-bufsize', k(kb * 2)] : ['-maxrate', k(kb * 1.3), '-bufsize', k(kb * 2)];

  if (enc.hw === 'nvenc') {
    const p = { ultrafast: 'p1', superfast: 'p2', veryfast: 'p2', faster: 'p3', fast: 'p4', medium: 'p5', slow: 'p6', slower: 'p7', veryslow: 'p7' }[preset] || 'p5';
    const a = ['-c:v', enc.name, '-preset', p, '-tune', 'hq', '-pix_fmt', 'yuv420p'];
    if (mode === 'crf') a.push('-rc', 'vbr', '-cq', String(s.crf), '-b:v', '0');
    else a.push('-rc', 'vbr', '-b:v', k(kb), ...vbv, ...(mode === 'bitrate' ? [] : ['-multipass', 'fullres']));
    if (s.codec === 'h265' && mp4ish) a.push('-tag:v', 'hvc1');
    return a;
  }
  if (enc.hw === 'qsv') {
    const p = ['ultrafast', 'superfast'].includes(preset) ? 'veryfast' : preset;
    const a = ['-c:v', enc.name, '-preset', p, '-pix_fmt', 'nv12'];
    if (mode === 'crf') a.push('-global_quality', String(s.crf));
    else a.push('-b:v', k(kb), ...vbv);
    if (s.codec === 'h265' && mp4ish) a.push('-tag:v', 'hvc1');
    return a;
  }
  if (enc.hw === 'amf') {
    const q = ['ultrafast', 'superfast', 'veryfast', 'faster'].includes(preset) ? 'speed' : ['slow', 'slower', 'veryslow'].includes(preset) ? 'quality' : 'balanced';
    const a = ['-c:v', enc.name, '-quality', q, '-pix_fmt', 'yuv420p'];
    if (mode === 'crf') a.push('-rc', 'cqp', '-qp_i', String(s.crf), '-qp_p', String(s.crf), ...(s.codec === 'h264' ? ['-qp_b', String(s.crf)] : []));
    else a.push('-rc', 'vbr_peak', '-b:v', k(kb), ...vbv);
    if (s.codec === 'h265' && mp4ish) a.push('-tag:v', 'hvc1');
    return a;
  }

  switch (s.codec) {
    case 'h264': {
      const a = ['-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p'];
      if (mode === 'crf') a.push('-crf', String(s.crf));
      else if (pass) a.push('-b:v', k(kb), '-pass', String(pass), '-passlogfile', 'ffpass');
      else a.push('-b:v', k(kb), ...vbv);
      return a;
    }
    case 'h265': {
      const params = ['log-level=error'];
      const a = ['-c:v', 'libx265', '-preset', preset, '-pix_fmt', 'yuv420p'];
      if (mode === 'crf') a.push('-crf', String(s.crf));
      else if (pass) { a.push('-b:v', k(kb)); params.push(`pass=${pass}`, 'stats=x265stats.log'); }
      else a.push('-b:v', k(kb), ...vbv);
      a.push('-x265-params', params.join(':'));
      if (mp4ish) a.push('-tag:v', 'hvc1');
      return a;
    }
    case 'vp9': {
      const cpu = { ultrafast: 8, superfast: 7, veryfast: 6, faster: 5, fast: 4, medium: 3, slow: 2, slower: 1, veryslow: 0 }[preset] ?? 3;
      const a = ['-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', String(cpu), '-pix_fmt', 'yuv420p'];
      if (mode === 'crf') a.push('-crf', String(s.crf), '-b:v', '0');
      else if (pass) a.push('-b:v', k(kb), '-pass', String(pass), '-passlogfile', 'ffpass');
      else a.push('-b:v', k(kb), ...vbv);
      return a;
    }
    case 'av1': {
      if (enc.name === 'libaom-av1') {
        const a = ['-c:v', 'libaom-av1', '-cpu-used', '6', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
        if (mode === 'crf') a.push('-crf', String(s.crf), '-b:v', '0');
        else a.push('-b:v', k(kb));
        return a;
      }
      const p = { ultrafast: 12, superfast: 11, veryfast: 10, faster: 9, fast: 8, medium: 7, slow: 5, slower: 4, veryslow: 3 }[preset] ?? 7;
      const a = ['-c:v', 'libsvtav1', '-preset', String(p), '-pix_fmt', 'yuv420p'];
      if (mode === 'crf') a.push('-crf', String(s.crf));
      else a.push('-b:v', k(kb));
      return a;
    }
    case 'prores':
      return ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0'];
    default:
      throw new Error(`Códec no soportado: ${s.codec}`);
  }
}

function audioArgs(s, plan, caps) {
  const id = Core.audioCodecFor(s);
  const kb = k(plan.audioKbps);
  const a = {
    aac: ['-c:a', 'aac', '-b:a', kb],
    mp3: ['-c:a', 'libmp3lame', '-b:a', kb],
    opus: caps.sw.opus ? ['-c:a', 'libopus', '-b:a', kb] : ['-c:a', 'opus', '-b:a', kb, '-strict', '-2'],
    vorbis: ['-c:a', 'libvorbis', '-b:a', kb],
    ac3: ['-c:a', 'ac3', '-b:a', k(Math.min(640, plan.audioKbps))],
    flac: ['-c:a', 'flac'],
    alac: ['-c:a', 'alac'],
    pcm: ['-c:a', 'pcm_s16le'],
  }[id] || ['-c:a', 'aac', '-b:a', kb];
  return [...a, ...sampleArgs(s)];
}

// Frecuencia de muestreo y canales (si se pidieron).
function sampleArgs(o) {
  const a = [];
  if (o.sampleRate && o.sampleRate !== 'original') a.push('-ar', String(o.sampleRate));
  if (o.channels && o.channels !== 'original') a.push('-ac', String(o.channels));
  return a;
}

// Códec de audio de un archivo de solo audio, según el formato (Core.AUDIO_FORMATS).
function audioFormatArgs(fmt, kbps, srcCodec) {
  const kb = `${kbps || 256}k`;
  switch (fmt) {
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', kb];
    case 'm4a': return ['-c:a', 'aac', '-b:a', kb, '-movflags', '+faststart'];
    case 'aac': return ['-c:a', 'aac', '-b:a', kb, '-f', 'adts'];
    case 'ogg': return ['-c:a', 'libopus', '-b:a', kb, '-f', 'ogg'];
    case 'vorbis': return ['-c:a', 'libvorbis', '-b:a', kb, '-f', 'ogg'];
    case 'opus': return ['-c:a', 'libopus', '-b:a', kb, '-f', 'opus'];
    case 'ac3': return ['-c:a', 'ac3', '-b:a', `${Math.min(640, kbps || 256)}k`];
    case 'flac': return ['-c:a', 'flac'];
    case 'alac': return ['-c:a', 'alac', '-movflags', '+faststart'];
    case 'wav24': return ['-c:a', 'pcm_s24le'];
    case 'wav': return ['-c:a', /^pcm_s24/.test(srcCodec || '') ? 'pcm_s24le' : 'pcm_s16le'];
    default: throw new Error(`Formato no soportado: ${fmt}`);
  }
}
const EXT_FORMAT = { mp3: 'mp3', m4a: 'm4a', ogg: 'ogg', flac: 'flac', wav: 'wav', aac: 'aac', opus: 'opus', ac3: 'ac3' };

/**
 * Construye los comandos de FFmpeg para un trabajo de exportación.
 * job = { clips: [...], settings: {...}, outputPath }
 */
async function buildExport(job, workDir) {
  const caps = await capabilities();
  const s = Core.normalizeSettings(job.settings);
  const clips = job.clips;
  const plan = Core.planOutput(clips, s);
  if (plan.error) throw new Error(plan.error);

  const enc = s.audioOnly || s.codec === 'gif' ? { hw: null, name: s.audioOnly ? 'audio' : 'gif' } : resolveEncoder(s, caps);
  if (!enc.hw && !s.audioOnly && s.codec !== 'gif') {
    const avail = { h264: caps.sw.h264, h265: caps.sw.h265, vp9: caps.sw.vp9, av1: !!caps.sw.av1, prores: caps.sw.prores }[s.codec];
    if (!avail) throw new Error(`Tu versión de FFmpeg no incluye el codificador ${Core.CODECS[s.codec].label}.`);
  }
  const withAudio = s.audio !== false;
  const twoPass = (plan.rateMode === 'size' || plan.rateMode === 'percent') && s.twoPass && !enc.hw && Core.CODECS[s.codec].twoPass;

  const texts = job.texts || [];
  const audios = (job.audios || []).filter((a) => a.start < plan.duration - 0.01 && a.out - a.in > 0.01);
  const g = { clips, texts: [], audios };
  const inputs = [];
  for (const c of clips) {
    inputs.push('-ss', num(c.in, 6), '-t', num(c.out - c.in, 6), '-i', c.path);
  }
  for (let k = 0; k < texts.length; k++) {
    const t = texts[k];
    const file = path.join(workDir, `text${k}.png`);
    await fsp.writeFile(file, Buffer.from(t.png));
    g.texts.push({ start: t.start, duration: t.duration, fadeIn: t.fadeIn, fadeOut: t.fadeOut, file });
    inputs.push('-loop', '1', '-framerate', plan.fpsStr, '-t', num(t.duration, 6), '-i', file);
  }
  for (const a of audios) {
    inputs.push('-ss', num(a.in, 6), '-t', num(a.out - a.in, 6), '-i', a.path);
  }

  // Solo audio: la imagen se descarta; GIF: paleta propia para que los colores se vean bien.
  const tail = s.audioOnly ? ';\n[vout]nullsink'
    : s.codec === 'gif' ? ';\n[vout]split[gv1][gv2];[gv1]palettegen=stats_mode=diff[gpal];[gv2][gpal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[gout]' : '';
  const graphArgs = async (audio, name) => {
    const g2 = buildGraph(g, plan, s, audio) + tail;
    if (g2.length < 24000) return ['-filter_complex', g2];
    const f = path.join(workDir, name);
    await fsp.writeFile(f, g2, 'utf8');
    return bin.newScriptSyntax ? ['-/filter_complex', f] : ['-filter_complex_script', f];
  };

  const common = ['-map_metadata', '-1'];
  const container = s.container === 'mp4' || s.container === 'mov' ? ['-movflags', '+faststart'] : [];
  const passes = [];
  if (twoPass) {
    passes.push([...inputs, ...(await graphArgs(false, 'graph1.txt')), '-map', '[vout]', ...videoArgs(s, plan, enc, 1),
      '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null']);
  }
  if (s.audioOnly) {
    passes.push(['-y', ...inputs, ...(await graphArgs(true, 'graph2.txt')), '-map', '[aout]', '-vn',
      ...audioFormatArgs(s.aformat, plan.audioKbps), ...sampleArgs(s), ...common, job.outputPath]);
    return { plan, passes, encoder: (Core.AUDIO_FORMATS.find((x) => x.id === s.aformat) || {}).label || 'Audio' };
  }
  if (s.codec === 'gif') {
    passes.push(['-y', ...inputs, ...(await graphArgs(false, 'graph2.txt')), '-map', '[gout]', '-an', '-loop', '0', ...common, '-f', 'gif', job.outputPath]);
    return { plan, passes, encoder: 'GIF' };
  }
  const audioOut = withAudio ? ['-map', '[aout]', ...audioArgs(s, plan, caps)] : ['-an'];
  passes.push(['-y', ...inputs, ...(await graphArgs(withAudio, 'graph2.txt')), '-map', '[vout]',
    ...videoArgs(s, plan, enc, twoPass ? 2 : 0), ...audioOut, ...common, ...container, job.outputPath]);
  return { plan, passes, encoder: enc.name };
}

function exportVideo(job, onProgress) {
  let current = null, cancelled = false;
  const promise = (async () => {
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fotograma-job-'));
    const started = Date.now();
    try {
      const { plan, passes, encoder } = await buildExport(job, workDir);
      for (let p = 0; p < passes.length; p++) {
        if (cancelled) throw Object.assign(new Error('Cancelado por el usuario'), { cancelled: true });
        current = runFfmpeg(passes[p], {
          cwd: workDir,
          duration: plan.duration,
          onProgress: (pr) => onProgress && onProgress({
            ...pr, pass: p + 1, passes: passes.length,
            overall: (p + pr.pct) / passes.length,
            elapsed: (Date.now() - started) / 1000,
          }),
        });
        await current.promise;
      }
      const size = fs.statSync(job.outputPath).size;
      return { path: job.outputPath, size, plan, encoder, elapsed: (Date.now() - started) / 1000 };
    } catch (e) {
      try { if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath); } catch { /* ignorar */ }
      throw e;
    } finally {
      fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      if (current) current.cancel();
    },
  };
}

// ---------------------------------------------------------------------------
// Audio Studio
// ---------------------------------------------------------------------------
// Convierte cualquier archivo a WAV (para decodificarlo en la interfaz).
function extractAudio(file) {
  return heavy(async () => {
    const out = path.join(cacheDir, `${cacheKey(file)}_audio.wav`);
    if (!exists(out)) {
      const part = out.replace(/\.wav$/, '.part.wav');
      await run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', part]);
      await fsp.rename(part, out);
    }
    return mediaUrl(out);
  });
}

/**
 * Codifica el WAV renderizado por el Audio Studio.
 * opts = { wav: Uint8Array, outputPath, format: mp3|wav|flac|m4a|mp4, kbps, title, cover, duration }
 */
function encodeAudio(opts, onProgress) {
  let current = null, cancelled = false;
  const promise = (async () => {
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fotograma-audio-'));
    const started = Date.now();
    try {
      const wav = path.join(workDir, 'render.wav');
      await fsp.writeFile(wav, Buffer.from(opts.wav));
      const meta = opts.title ? ['-metadata', `title=${opts.title}`] : [];
      const kb = `${opts.kbps || 320}k`;
      let args;
      if (opts.format === 'mp4') {
        const W = 1920, H = 1080;
        const src = opts.cover
          ? ['-loop', '1', '-framerate', '30', '-i', opts.cover]
          : ['-f', 'lavfi', '-i', `color=c=0x15121f:s=${W}x${H}:r=30`];
        const graph = opts.cover
          ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:3,eq=brightness=-0.12[bg];` +
            `[0:v]scale=1400:780:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2-70[b2];` +
            `[1:a]showwaves=s=${W}x170:mode=cline:rate=30:colors=white@0.6[w];[b2][w]overlay=0:H-h-24:shortest=1,format=yuv420p[v]`
          : `[1:a]showwaves=s=${W}x420:mode=cline:rate=30:colors=0x9d91ff[w];[0:v][w]overlay=0:(H-h)/2:shortest=1,format=yuv420p[v]`;
        args = ['-y', ...src, '-i', wav, '-filter_complex', graph, '-map', '[v]', '-map', '1:a',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30', '-c:a', 'aac', '-b:a', kb,
          '-shortest', '-movflags', '+faststart', ...meta, opts.outputPath];
      } else {
        args = ['-y', '-i', wav, ...audioFormatArgs(opts.format, opts.kbps || 320), ...sampleArgs(opts), ...meta, opts.outputPath];
      }
      if (cancelled) throw Object.assign(new Error('Cancelado por el usuario'), { cancelled: true });
      current = runFfmpeg(args, {
        cwd: workDir, duration: opts.duration,
        onProgress: (pr) => onProgress && onProgress({ ...pr, overall: pr.pct, pass: 1, passes: 1, elapsed: (Date.now() - started) / 1000 }),
      });
      await current.promise;
      return { path: opts.outputPath, size: fs.statSync(opts.outputPath).size, elapsed: (Date.now() - started) / 1000, encoder: opts.format.toUpperCase() };
    } catch (e) {
      try { if (fs.existsSync(opts.outputPath)) fs.unlinkSync(opts.outputPath); } catch { /* ignorar */ }
      throw e;
    } finally {
      fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return { promise, cancel() { cancelled = true; if (current) current.cancel(); } };
}

// ---------------------------------------------------------------------------
// Cortador de audio
// ---------------------------------------------------------------------------
// "original" recodifica al formato natural de la extensión de salida.
function audioCodecArgs(format, ext, kbps, srcCodec) {
  return audioFormatArgs(format === 'original' ? EXT_FORMAT[ext] || 'mp3' : format, kbps, srcCodec);
}

/**
 * Recorta o une fragmentos de un audio.
 * opts = { input, outputPath, segments: [{ start, end }], fadeIn, fadeOut, gainDb, normalize,
 *          format: 'original'|'mp3'|…, kbps, acodec }
 * Con un solo fragmento, sin fundidos ni ajustes y en formato original, copia el
 * flujo sin recodificar (instantáneo y sin pérdida).
 */
function cutAudio(opts, onProgress) {
  let current = null, cancelled = false;
  const promise = (async () => {
    const started = Date.now();
    const segs = opts.segments.filter((x) => x.end - x.start > 0.01);
    if (!segs.length) throw new Error('No hay ningún fragmento que exportar.');
    const total = segs.reduce((t, x) => t + x.end - x.start, 0);
    const ext = Core.audioOutExt(opts.format, opts.acodec);
    const plain = !opts.fadeIn && !opts.fadeOut && !opts.normalize && !opts.gainDb && !sampleArgs(opts).length;
    const canCopy = opts.format === 'original' && Core.audioExtForCodec(opts.acodec) === ext;
    const copy = canCopy && segs.length === 1 && plain;
    await fsp.mkdir(path.dirname(opts.outputPath), { recursive: true });
    let args;
    if (copy) {
      const sg = segs[0];
      args = ['-y', '-ss', num(sg.start, 6), '-t', num(sg.end - sg.start, 6), '-i', opts.input,
        '-map', '0:a:0', '-c', 'copy', '-map_metadata', '0', opts.outputPath];
    } else {
      const parts = segs.map((sg, i) => `[0:a:0]atrim=start=${num(sg.start, 6)}:end=${num(sg.end, 6)},asetpts=PTS-STARTPTS[s${i}]`);
      const f = [];
      if (opts.gainDb) f.push(`volume=${num(opts.gainDb, 2)}dB`);
      if (opts.normalize) f.push('loudnorm=I=-14:TP=-1.5:LRA=11');
      if (opts.fadeIn > 0) f.push(`afade=t=in:st=0:d=${num(Math.min(opts.fadeIn, total), 3)}`);
      if (opts.fadeOut > 0) f.push(`afade=t=out:st=${num(Math.max(0, total - opts.fadeOut), 3)}:d=${num(Math.min(opts.fadeOut, total), 3)}`);
      if (opts.normalize) f.push('aresample=48000');
      const head = segs.length > 1
        ? `${parts.join(';')};${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${segs.length}:v=0:a=1`
        : parts[0].replace(/\[s0\]$/, '');
      const graph = `${head}${f.length ? `${segs.length > 1 ? ',' : ','}${f.join(',')}` : ''}[out]`;
      args = ['-y', '-i', opts.input, '-filter_complex', graph, '-map', '[out]', '-map_metadata', '0',
        ...audioCodecArgs(opts.format, ext, opts.kbps, opts.acodec), ...sampleArgs(opts), opts.outputPath];
    }
    if (cancelled) throw Object.assign(new Error('Cancelado por el usuario'), { cancelled: true });
    current = runFfmpeg(args, {
      duration: total,
      onProgress: (pr) => onProgress && onProgress({ ...pr, overall: pr.pct, pass: 1, passes: 1, elapsed: (Date.now() - started) / 1000 }),
    });
    try {
      await current.promise;
    } catch (e) {
      try { if (fs.existsSync(opts.outputPath)) fs.unlinkSync(opts.outputPath); } catch { /* ignorar */ }
      throw e;
    }
    return { path: opts.outputPath, size: fs.statSync(opts.outputPath).size, elapsed: (Date.now() - started) / 1000, encoder: copy ? 'Copia directa (sin recodificar)' : ext.toUpperCase(), copy };
  })();
  return { promise, cancel() { cancelled = true; if (current) current.cancel(); } };
}

// ---------------------------------------------------------------------------
// Fuentes de una grabación
// ---------------------------------------------------------------------------
/**
 * Exporta por separado las pistas de audio (y opcionalmente el vídeo sin audio).
 * opts = { input, outDir, baseName, tracks: [{ i, name, codec }], video: bool, format, kbps, duration }
 */
function exportTracks(opts, onProgress) {
  let current = null, cancelled = false;
  const promise = (async () => {
    const started = Date.now();
    await fsp.mkdir(opts.outDir, { recursive: true });
    const safe = (n) => String(n).replace(/[<>:"/\\|?*]+/g, '_').trim().slice(0, 80) || 'pista';
    const unique = (file) => {
      let f = file;
      const ext = path.extname(file), stem = file.slice(0, -ext.length);
      for (let n = 2; fs.existsSync(f); n++) f = `${stem} (${n})${ext}`;
      return f;
    };
    const args = ['-y', '-i', opts.input];
    const outputs = [];
    if (opts.video) {
      const ext = path.extname(opts.input).toLowerCase() === '.mkv' ? 'mkv' : 'mp4';
      const out = unique(path.join(opts.outDir, `${safe(opts.baseName)} - vídeo.${ext}`));
      args.push('-map', '0:v:0', '-c', 'copy', '-an', ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []), out);
      outputs.push(out);
    }
    for (const t of opts.tracks || []) {
      const ext = Core.audioOutExt(opts.format, t.codec);
      const out = unique(path.join(opts.outDir, `${safe(opts.baseName)} - ${safe(t.name)}.${ext}`));
      const codec = opts.format === 'original' && Core.audioExtForCodec(t.codec) === ext ? ['-c:a', 'copy'] : [...audioCodecArgs(opts.format, ext, opts.kbps, t.codec), ...sampleArgs(opts)];
      args.push('-map', `0:a:${t.i}`, '-vn', ...codec, ...(ext === 'm4a' && codec[1] === 'copy' ? ['-movflags', '+faststart'] : []), out);
      outputs.push(out);
    }
    if (!outputs.length) throw new Error('No hay nada que exportar.');
    current = runFfmpeg(args, {
      duration: opts.duration,
      onProgress: (pr) => onProgress && onProgress({ ...pr, overall: pr.pct, pass: 1, passes: 1, elapsed: (Date.now() - started) / 1000 }),
    });
    try {
      await current.promise;
    } catch (e) {
      for (const f of outputs) { try { fs.unlinkSync(f); } catch { /* ignorar */ } }
      throw e;
    }
    return { paths: outputs, elapsed: (Date.now() - started) / 1000 };
  })();
  return { promise, cancel() { cancelled = true; if (current) current.cancel(); } };
}

/**
 * Estira un vídeo a 1920×1080 (16:9) como escalador.bat: x264 CRF 18 y audio copiado
 * (se conservan todas las pistas).
 */
function stretchVideo(opts, onProgress) {
  let current = null;
  const promise = (async () => {
    const started = Date.now();
    const ext = path.extname(opts.input);
    let out = opts.outputPath || `${opts.input.slice(0, -ext.length)}_1080p_Estirado${ext}`;
    for (let n = 2; fs.existsSync(out); n++) out = `${opts.input.slice(0, -ext.length)}_1080p_Estirado (${n})${ext}`;
    const w = opts.width || 1920, hgt = opts.height || 1080;
    current = runFfmpeg(['-y', '-i', opts.input, '-map', '0:v:0', '-map', '0:a?', '-vf', `scale=${w}:${hgt}:flags=bicubic,setsar=1`, '-aspect', '16:9',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
      ...(/\.mp4$/i.test(out) ? ['-movflags', '+faststart'] : []), out], {
      duration: opts.duration,
      onProgress: (pr) => onProgress && onProgress({ ...pr, overall: pr.pct, pass: 1, passes: 1, elapsed: (Date.now() - started) / 1000 }),
    });
    try {
      await current.promise;
    } catch (e) {
      try { fs.unlinkSync(out); } catch { /* ignorar */ }
      throw e;
    }
    return { path: out, size: fs.statSync(out).size, elapsed: (Date.now() - started) / 1000 };
  })();
  return { promise, cancel() { if (current) current.cancel(); } };
}

module.exports = {
  exportTracks, stretchVideo, setHwPreference,
  cutAudio, extractAudio, encodeAudio, mediaUrl,
  init, probe, thumbnails, waveform, proxy, capabilities, exportVideo, buildExport, buildGraph,
  get bin() { return { ...bin }; },
};
