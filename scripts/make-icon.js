// Genera build/icon.png (512×512) dibujando el logotipo con canvas en Electron.
// Uso: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<canvas id="c" width="512" height="512"></canvas><script>
const c = document.getElementById('c'), x = c.getContext('2d');
const r = 112;
x.beginPath(); x.roundRect(16, 16, 480, 480, r); x.closePath();
const g = x.createConicGradient(3.66, 256, 256);
g.addColorStop(0, '#8b7bff'); g.addColorStop(0.33, '#2dd4bf'); g.addColorStop(0.66, '#f472b6'); g.addColorStop(1, '#8b7bff');
x.fillStyle = g; x.fill();
// Brillo superior
const hi = x.createLinearGradient(0, 16, 0, 300);
hi.addColorStop(0, 'rgba(255,255,255,.35)'); hi.addColorStop(1, 'rgba(255,255,255,0)');
x.fillStyle = hi; x.fill();
// Panel oscuro
x.beginPath(); x.roundRect(92, 92, 328, 328, 74); x.fillStyle = 'rgba(14,15,24,.92)'; x.fill();
// Triángulo de reproducción
x.beginPath(); x.moveTo(214, 168); x.lineTo(214, 344); x.lineTo(352, 256); x.closePath();
const pg = x.createLinearGradient(214, 168, 352, 344);
pg.addColorStop(0, '#c4bcff'); pg.addColorStop(1, '#5eead4');
x.fillStyle = pg; x.lineJoin = 'round'; x.lineWidth = 26; x.strokeStyle = pg; x.stroke(); x.fill();
// Barras de onda
x.fillStyle = 'rgba(255,255,255,.85)';
[[140, 40], [164, 72], [188, 30]].forEach(([px, hgt]) => { x.beginPath(); x.roundRect(px - 7, 256 - hgt / 2, 14, hgt, 7); x.fill(); });
</script>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 512, height: 512, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const data = await win.webContents.executeJavaScript("document.getElementById('c').toDataURL('image/png')");
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
  console.log('Icono generado:', out);
  app.quit();
});
