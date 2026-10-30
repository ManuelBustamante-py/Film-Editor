'use strict';
/*
 * Detección del equipo (tarjetas gráficas, procesador, memoria y pantallas) y configuración
 * recomendada para la captura y la exportación. Así la aplicación se adapta sola al instalarla
 * en otro PC: NVIDIA, AMD o Intel, con tarjeta dedicada o integrada, o sin GPU utilizable.
 */
const os = require('os');
const { spawn } = require('child_process');

const VENDOR_ENC = { nvidia: 'nvenc', amd: 'amf', intel: 'qsv' };
const VENDOR_LABEL = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', other: 'Otra' };

function vendorOf(name, compat) {
  const s = `${name} ${compat}`.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx/.test(s)) return 'nvidia';
  if (/amd|radeon|advanced micro/.test(s)) return 'amd';
  if (/intel/.test(s)) return 'intel';
  return 'other';
}

// Integrada o dedicada, por el nombre (Windows no lo indica directamente).
function isIntegrated(vendor, name) {
  const n = String(name);
  if (vendor === 'nvidia') return false;
  if (vendor === 'intel') return !/\barc\b/i.test(n);
  // "AMD Radeon(TM) Graphics", "Radeon 780M Graphics", "RX Vega 11 Graphics" son integradas;
  // "Radeon RX 6700 XT" o "Radeon Pro W6800", dedicadas.
  if (vendor === 'amd') return /graphics/i.test(n) && !/\brx\s*\d{3,4}/i.test(n);
  return true;
}

function powershellJson(script, timeout = 15000) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => {
      clearTimeout(t);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

let cached = null;

/** Datos del equipo. displays: screen.getAllDisplays() de Electron (para la frecuencia). */
async function detect(displays = []) {
  if (cached) return cached;
  const cpus = os.cpus();
  const info = {
    os: `Windows ${os.release()}`,
    cpu: { model: (cpus[0] && cpus[0].model || 'Desconocido').trim(), threads: cpus.length, vendor: /amd/i.test(cpus[0] && cpus[0].model) ? 'amd' : /intel/i.test(cpus[0] && cpus[0].model) ? 'intel' : 'other' },
    ramGB: Math.round(os.totalmem() / 2 ** 30),
    gpus: [],
    displays: displays.map((d) => ({ w: Math.round(d.size.width * (d.scaleFactor || 1)), h: Math.round(d.size.height * (d.scaleFactor || 1)), hz: Math.round(d.displayFrequency || 60) })),
  };
  if (process.platform === 'win32') {
    const j = await powershellJson('Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,AdapterRAM,DriverVersion | ConvertTo-Json -Compress');
    for (const g of [].concat(j || [])) {
      if (!g || !g.Name || /basic display|basic render|virtual|parsec|remote/i.test(g.Name)) continue;
      const vendor = vendorOf(g.Name, g.AdapterCompatibility || '');
      info.gpus.push({
        name: g.Name.trim(), vendor, vendorLabel: VENDOR_LABEL[vendor], integrated: isIntegrated(vendor, g.Name),
        // AdapterRAM se queda en 4 GB como máximo (campo de 32 bits).
        vramMB: g.AdapterRAM ? Math.round(g.AdapterRAM / 2 ** 20) : null, driver: g.DriverVersion || '',
      });
    }
  }
  cached = info;
  return info;
}

/**
 * Configuración recomendada para este equipo.
 * caps: engine.capabilities() (codificadores por GPU que funcionan de verdad).
 */
function recommend(info, caps) {
  const working = Object.keys((caps && caps.hw) || {});
  // Codificadores por GPU en orden: primero los de tarjetas dedicadas, luego las integradas.
  const gpus = [...info.gpus].sort((a, b) => Number(a.integrated) - Number(b.integrated));
  const order = [...new Set(gpus.map((g) => VENDOR_ENC[g.vendor]).filter((e) => e && working.includes(e)))];
  for (const e of ['nvenc', 'amf', 'qsv']) if (working.includes(e) && !order.includes(e)) order.push(e);
  const enc = order[0] || 'x264';
  const gpu = gpus.find((g) => VENDOR_ENC[g.vendor] === enc) || null;
  const maxHz = Math.max(60, ...info.displays.map((d) => d.hz || 60));
  const strongCpu = info.cpu.threads >= 12;
  const capture = enc === 'x264'
    // Sin codificador por GPU: la CPU tiene que codificar mientras se juega.
    ? { encoder: 'x264', codec: 'h264', rate: 'cqp', quality: 23, preset: 'speed', video: { fps: strongCpu ? 60 : 30 } }
    : { encoder: enc, codec: 'h264', rate: 'cqp', quality: 20, preset: 'balanced', video: { fps: 60 } };
  const notes = [];
  if (enc === 'x264') notes.push('No hay codificador por GPU utilizable: se codifica con la CPU (más carga mientras juegas). Actualiza los controladores de la tarjeta gráfica si tienes una.');
  else notes.push(`Codificación por GPU con ${gpu ? gpu.name : enc.toUpperCase()}${gpu && gpu.integrated ? ' (integrada)' : ''}.`);
  if (gpu && gpu.integrated) notes.push('Gráfica integrada: el juego y la captura comparten la GPU. Prioridad alta y conversión en la GPU para no perder imágenes.');
  if (maxHz > 60) notes.push(`Pantalla de ${maxHz} Hz: se graba a 60 fps (lo más fluido y ligero). Puedes subir a 120 o ${maxHz} si tu equipo va sobrado.`);
  return { hwOrder: order, encoder: enc, capture, maxHz, notes };
}

module.exports = { detect, recommend, isIntegrated, vendorOf };
