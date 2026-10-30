'use strict';
/*
 * Copia un FFmpeg moderno a vendor/ffmpeg para incluirlo en el instalador y en el portable.
 * Así la aplicación funciona igual en cualquier equipo, aunque no tenga FFmpeg instalado
 * (captura por GPU con ddagrab, conversión en la GPU con vpp_amf/scale_d3d11, gfxcapture…).
 *
 * Uso: node scripts/vendor-ffmpeg.js [carpeta con ffmpeg.exe y ffprobe.exe]
 * Sin carpeta, usa el FFmpeg que haya en el PATH (p. ej. una build "essentials" de gyan.dev).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEST = path.join(__dirname, '..', 'vendor', 'ffmpeg');

function findDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const r = spawnSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  const first = (r.stdout || '').split(/\r?\n/).find((l) => /ffmpeg\.exe$/i.test(l.trim()));
  if (!first) throw new Error('No hay FFmpeg en el PATH. Indica la carpeta: node scripts/vendor-ffmpeg.js C:\\ffmpeg\\bin');
  return path.dirname(first.trim());
}

const src = findDir();
const need = ['ffmpeg.exe', 'ffprobe.exe'];
for (const f of need) if (!fs.existsSync(path.join(src, f))) throw new Error(`Falta ${f} en ${src}`);

// Comprueba que tenga lo que usa la captura.
const filters = spawnSync(path.join(src, 'ffmpeg.exe'), ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true }).stdout || '';
const missing = ['ddagrab', 'gfxcapture', 'vpp_amf', 'scale_d3d11'].filter((n) => !new RegExp(`\\s${n}\\s`).test(filters));
if (missing.length) console.warn(`Aviso: este FFmpeg no incluye ${missing.join(', ')}; la captura irá más lenta en algunos equipos.`);

fs.mkdirSync(DEST, { recursive: true });
let copied = 0;
for (const f of need) {
  const a = path.join(src, f), b = path.join(DEST, f);
  if (fs.existsSync(b) && fs.statSync(b).size === fs.statSync(a).size) continue;
  fs.copyFileSync(a, b);
  copied++;
}
// Licencia de FFmpeg (GPL): debe acompañar a los binarios.
for (const f of ['LICENSE', 'LICENSE.txt', 'README.txt']) {
  const a = path.join(src, '..', f);
  if (fs.existsSync(a)) fs.copyFileSync(a, path.join(DEST, f === 'README.txt' ? 'README-ffmpeg.txt' : 'LICENSE-ffmpeg.txt'));
}
const v = /ffmpeg version (\S+)/.exec(spawnSync(path.join(DEST, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true }).stdout || '');
console.log(`FFmpeg ${v ? v[1] : '?'} en vendor/ffmpeg (${copied ? `${copied} archivo(s) copiados` : 'ya estaba al día'}).`);
