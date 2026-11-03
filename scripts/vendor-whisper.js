'use strict';
/*
 * Descarga whisper.cpp (reconocimiento de voz sin conexión, licencia MIT) a vendor/whisper para
 * incluirlo en el instalador y en el portable. Solo se copian whisper-cli y sus bibliotecas; los
 * modelos se descargan desde la app la primera vez que se generan subtítulos.
 *
 * Uso: node scripts/vendor-whisper.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const TAG = 'b5454';
const ZIP = `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-bin-x64.zip`;
const LICENSE = `https://raw.githubusercontent.com/ggml-org/whisper.cpp/${TAG}/LICENSE`;
const DEST = path.join(__dirname, '..', 'vendor', 'whisper');
const KEEP = /^(whisper-cli\.exe|whisper\.dll|ggml(-base|-cpu-[\w]+)?\.dll)$/i;

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Fotograma-Studio' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).href, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} en ${url}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(path.join(DEST, 'whisper-cli.exe')) && fs.existsSync(path.join(DEST, 'VERSION.txt'))
    && fs.readFileSync(path.join(DEST, 'VERSION.txt'), 'utf8').trim() === TAG) {
    console.log(`whisper.cpp ${TAG} ya está en vendor/whisper.`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const zip = path.join(tmp, 'whisper.zip');
  fs.writeFileSync(zip, await get(ZIP));
  // tar de Windows 10/11 descomprime ZIP.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-xf', zip, '-C', tmp], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`No se pudo descomprimir: ${r.stderr}`);
  const rel = path.join(tmp, 'Release');
  fs.mkdirSync(DEST, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(rel)) if (KEEP.test(f)) { fs.copyFileSync(path.join(rel, f), path.join(DEST, f)); n++; }
  fs.writeFileSync(path.join(DEST, 'LICENSE-whisper.cpp.txt'), await get(LICENSE));
  fs.writeFileSync(path.join(DEST, 'VERSION.txt'), TAG);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`whisper.cpp ${TAG} en vendor/whisper (${n} archivos).`);
})().catch((e) => { console.error(e.message); process.exit(1); });
