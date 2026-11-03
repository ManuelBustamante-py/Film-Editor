'use strict';
/* Descarga un archivo con progreso (modelos de voz y de subtítulos). Se escribe en <destino>.part
   y se renombra al terminar, así una descarga cortada nunca deja un modelo a medias. */
const fs = require('fs');
const https = require('https');

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

module.exports = download;
