'use strict';
/*
 * Subtítulos automáticos con Whisper (whisper.cpp), sin conexión: el audio nunca sale del equipo.
 * Se extrae la pista elegida a 16 kHz, se corta en tramos de unos 2 min por un silencio y cada
 * tramo pasa por whisper-cli con detección de voz (Silero): sin ella, en los ratos sin voz se
 * inventa frases. Como las copias ligeras, solo avanza con el editor parado y con prioridad baja.
 * El resultado (en tiempo del archivo original) se guarda en la caché para no repetirlo.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const engine = require('./engine');
const download = require('./download');

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODELS = {
  fast: { file: 'ggml-base-q5_1.bin', size: 59707625 },
  precise: { file: 'ggml-small-q5_1.bin', size: 190085487 },
};
const VAD = { file: 'ggml-silero-v6.2.0.bin', size: 885098, url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin' };
const LANGS = ['es', 'en', 'pt', 'fr', 'it', 'de', 'auto'];
const SR = 16000;
const CHUNK = 120;

let modelsDir = path.join(os.tmpdir(), 'fotograma-whisper-models');
function init(opts = {}) { if (opts.modelsDir) modelsDir = opts.modelsDir; }

function cliPath() {
  const dirs = [process.resourcesPath && path.join(process.resourcesPath, 'whisper'), path.join(__dirname, '..', 'vendor', 'whisper')];
  for (const d of dirs) if (d && fs.existsSync(path.join(d, 'whisper-cli.exe'))) return path.join(d, 'whisper-cli.exe');
  return null;
}
const modelPath = (m) => path.join(modelsDir, m.file);
const have = (m) => fs.existsSync(modelPath(m)) && fs.statSync(modelPath(m)).size === m.size;

function status() {
  return { available: !!cliPath(), models: { fast: have(MODELS.fast), precise: have(MODELS.precise) }, sizes: { fast: MODELS.fast.size, precise: MODELS.precise.size } };
}

async function ensureModels(quality, onProgress, isCancelled) {
  const need = [MODELS[quality], VAD].filter((m) => !have(m));
  const total = need.reduce((n, m) => n + m.size, 0);
  let done = 0;
  await fsp.mkdir(modelsDir, { recursive: true });
  for (const m of need) {
    if (isCancelled()) return;
    await download(m.url || HF + m.file, modelPath(m), (f) => onProgress((done + f * m.size) / total));
    done += m.size;
  }
}

// Cortes de unos 2 min, cada uno en el momento más silencioso (0,5 s) a ±8 s del corte ideal,
// para no partir una frase.
function quietCuts(pcm) {
  const fr = SR / 10;
  const n = Math.floor(pcm.length / fr);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * fr, end = j + fr; j < end; j += 4) s += pcm[j] * pcm[j];
    e[i] = s;
  }
  const dur = pcm.length / SR;
  const cuts = [0];
  for (let b = CHUNK; b < dur - CHUNK / 4; b += CHUNK) {
    let best = Math.round(b * 10), bestE = Infinity;
    for (let i = Math.max(0, Math.round((b - 8) * 10)); i < Math.min(n - 5, Math.round((b + 8) * 10)); i++) {
      const s = e[i] + e[i + 1] + e[i + 2] + e[i + 3] + e[i + 4];
      if (s < bestE) { bestE = s; best = i; }
    }
    cuts.push((best + 2.5) / 10);
  }
  cuts.push(dur);
  return cuts;
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  const bytes = pcm.length * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, bytes)]);
}

function runCli(args, onProgress) {
  let child, cancelled = false;
  const promise = new Promise((resolve, reject) => {
    child = spawn(cliPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid, engine.bgPriority()); } catch { /* ignorar */ }
    let err = '';
    child.stderr.on('data', (d) => {
      const s = String(d);
      const m = /progress\s*=\s*(\d+)%/g;
      let x, last = null;
      while ((x = m.exec(s))) last = Number(x[1]);
      if (last != null) onProgress(last / 100);
      err = (err + s).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (cancelled) reject(Object.assign(new Error('Cancelado por el usuario'), { cancelled: true }));
      else if (code === 0) resolve();
      else reject(new Error(`El reconocimiento de voz falló (código ${code}). ${err.split('\n').filter((l) => /error|fail/i.test(l)).slice(-2).join(' ')}`.trim()));
    });
  });
  return { promise, get pid() { return child && child.pid; }, cancel() { cancelled = true; try { child && child.kill(); } catch { /* ya terminado */ } } };
}

// Quita lo que no es habla («[Música]», «(risas)», puntos sueltos) y las repeticiones en bucle
// que Whisper a veces encadena.
function clean(segs) {
  const out = [];
  for (const g of segs) {
    let t = g.t.replace(/\s+/g, ' ').trim();
    if (/^[[(*♪].*[\])*♪]$/.test(t) || !/[\p{L}\p{N}]/u.test(t)) continue;
    t = t.replace(/^-\s*/, '');
    const prev = out[out.length - 1], prev2 = out[out.length - 2];
    if (prev && prev2 && prev.t === t && prev2.t === t) continue;
    if (g.e - g.s < 0.05) continue;
    out.push({ s: +g.s.toFixed(3), e: +g.e.toFixed(3), t });
  }
  return out;
}

/** opts = { file, track, lang, quality, duration } → { promise: segmentos [{ s, e, t }], cancel } */
function transcribe(opts, onProgress) {
  let cancelled = false, current = null;
  const isCancelled = () => cancelled;
  const stop = () => { if (cancelled) throw Object.assign(new Error('Cancelado por el usuario'), { cancelled: true }); };
  const report = (phase, pct, extra) => onProgress && onProgress({ phase, pct: Math.max(0, Math.min(1, pct)), paused: engine.playbackActive, ...extra });
  const promise = (async () => {
    if (!cliPath()) throw new Error('Falta el motor de reconocimiento de voz (whisper). Reinstala la aplicación.');
    const quality = MODELS[opts.quality] ? opts.quality : 'precise';
    const lang = LANGS.includes(opts.lang) ? opts.lang : 'es';
    const track = Math.max(0, Number(opts.track) || 0);
    const key = engine.cacheKey(opts.file);
    const out = path.join(engine.cacheDir, `${key}_subs_${track}_${quality}_${lang}.json`);
    try { return JSON.parse(await fsp.readFile(out, 'utf8')).segments; } catch { /* no estaba */ }

    report('download', 0);
    await ensureModels(quality, (f) => report('download', f), isCancelled);
    stop();

    report('audio', 0);
    const raw = path.join(engine.cacheDir, `${key}_subs_${track}.pcm`);
    current = engine.runFfmpeg(['-y', '-i', opts.file, '-map', `0:a:${track}`, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', raw],
      { duration: opts.duration, onProgress: (p) => report('audio', p.pct), priority: engine.bgPriority() });
    await engine.background(current);
    stop();
    const buf = await fsp.readFile(raw);
    await fsp.rm(raw, { force: true });
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    const cuts = quietCuts(pcm);
    const n = cuts.length - 1;
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fotograma-subs-'));
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
    const segs = [];
    try {
      for (let i = 0; i < n; i++) {
        report('transcribe', i / n);
        await engine.whenIdle();
        stop();
        const a = Math.round(cuts[i] * SR), b = Math.round(cuts[i + 1] * SR);
        const f = path.join(tmp, `t${i}.wav`);
        await fsp.writeFile(f, wav(pcm.subarray(a, b)));
        const base = path.join(tmp, `t${i}`);
        current = runCli(['-m', modelPath(MODELS[quality]), '-f', f, '-l', lang, '-t', threads, '-mc', '0', '-ml', '60', '-sow',
          '--vad', '-vm', modelPath(VAD), '-vp', '200', '-vsd', '300', '-oj', '-of', base, '-pp'],
        (p) => report('transcribe', (i + p) / n));
        await engine.background(current);
        stop();
        const j = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8'));
        for (const x of j.transcription || []) {
          segs.push({ s: cuts[i] + x.offsets.from / 1000, e: cuts[i] + x.offsets.to / 1000, t: x.text || '' });
        }
      }
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    const result = clean(segs);
    await fsp.writeFile(out, JSON.stringify({ version: 1, file: opts.file, track, quality, lang, segments: result }));
    report('transcribe', 1);
    return result;
  })();
  return { promise, cancel() { cancelled = true; if (current) current.cancel(); } };
}

module.exports = { init, status, transcribe, quietCuts, clean };
