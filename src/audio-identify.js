'use strict';
/*
 * Identifica qué programa suena en cada fuente de audio (por ejemplo, qué bus de
 * Voicemeeter lleva Spotify y cuál el juego). Durante unos segundos se mide a la vez:
 *  - el nivel de cada sesión de audio de Windows (por programa), y
 *  - el nivel de cada fuente (dispositivo de entrada),
 * y se busca qué programa se parece más a cada fuente (correlación de las envolventes).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('./engine');

const STEP = 0.1; // s

// Script de PowerShell: niveles de las sesiones de audio por programa, cada 100 ms, en JSON.
const SAMPLER = String.raw`
param([int]$Samples = 60)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection { int GetCount(out int n); int Item(int i, out IMMDevice d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { int f1(); int f2(); int GetSessionEnumerator(out IAudioSessionEnumerator e); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { int GetCount(out int n); int GetSession(int i, out IAudioSessionControl2 s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int GetState(out int s); int a1(); int a2(); int a3(); int a4(); int a5(); int a6(); int a7(); int a8();
  int b1(); int b2(); int GetProcessId(out int pid);
}
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation { int GetPeakValue(out float peak); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public static class FsSessions {
  static List<KeyValuePair<string, IAudioMeterInformation>> meters = new List<KeyValuePair<string, IAudioMeterInformation>>();
  public static int Init() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDeviceCollection col; en.EnumAudioEndpoints(0, 1, out col);
    int n; col.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IMMDevice dev; col.Item(i, out dev);
      Guid iid = typeof(IAudioSessionManager2).GUID; object o;
      if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
      IAudioSessionEnumerator se; ((IAudioSessionManager2)o).GetSessionEnumerator(out se);
      int sc; se.GetCount(out sc);
      for (int k = 0; k < sc; k++) {
        IAudioSessionControl2 s; se.GetSession(k, out s);
        int pid; s.GetProcessId(out pid);
        if (pid == 0) continue;
        string name = "?"; try { name = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { continue; }
        meters.Add(new KeyValuePair<string, IAudioMeterInformation>(name, (IAudioMeterInformation)s));
      }
    }
    return meters.Count;
  }
  public static string Sample() {
    var peaks = new Dictionary<string, float>();
    foreach (var m in meters) {
      float p = 0; try { m.Value.GetPeakValue(out p); } catch {}
      float cur; if (!peaks.TryGetValue(m.Key, out cur) || p > cur) peaks[m.Key] = p;
    }
    var parts = new List<string>();
    foreach (var kv in peaks) parts.Add("\"" + kv.Key.Replace("\"", "") + "\":" + kv.Value.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture));
    return "{" + string.Join(",", parts) + "}";
  }
}
'@
[void][FsSessions]::Init()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
"START " + [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
for ($i = 0; $i -lt $Samples; $i++) {
  $t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  "S " + $t + " " + [FsSessions]::Sample()
  $wait = [int](($i + 1) * 100 - $sw.ElapsedMilliseconds)
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}
`;

function runSampler(seconds) {
  const file = path.join(os.tmpdir(), 'fotograma-audio-sessions.ps1');
  fs.writeFileSync(file, SAMPLER, 'utf8');
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Samples', String(Math.round(seconds / STEP))], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => {
      const samples = [];
      for (const line of out.split(/\r?\n/)) {
        const m = /^S (\d+) (\{.*\})$/.exec(line.trim());
        if (m) { try { samples.push({ t: Number(m[1]) / 1000, peaks: JSON.parse(m[2]) }); } catch { /* ignorar */ } }
      }
      if (!samples.length) reject(new Error(`No se pudieron leer las sesiones de audio de Windows.\n${err.trim().split(/\r?\n/).slice(-2).join('\n')}`));
      else resolve(samples);
    });
  });
}

// Nivel de una fuente (dispositivo DirectShow) cada 100 ms, con su hora real.
function sampleSource(src, seconds) {
  return new Promise((resolve) => {
    const t0 = Date.now() / 1000;
    const p = spawn(engine.bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '20',
      '-i', `audio=${src.alt || src.device}`, '-t', String(seconds + 1.5),
      '-af', 'aresample=48000,asetnsamples=n=4800:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-',
      '-f', 'null', '-'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve([]));
    p.on('close', () => {
      const pts = [];
      let t = 0;
      for (const line of out.split(/\r?\n/)) {
        const m = /pts_time:([\d.]+)/.exec(line);
        if (m) t = Number(m[1]);
        const v = /Peak_level=(-?[\d.]+|-inf)/.exec(line);
        if (v) pts.push({ t: t0 + t, v: v[1] === '-inf' ? 0 : Math.pow(10, Number(v[1]) / 20) });
      }
      resolve(pts);
    });
  });
}

function onGrid(series, start, n, get) {
  const out = new Array(n).fill(0);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = start + i * STEP;
    while (j < series.length - 1 && series[j + 1].t <= t) j++;
    out[i] = series.length ? get(series[j]) : 0;
  }
  return out;
}

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 1e-9 && db > 1e-9 ? num / Math.sqrt(da * db) : 0;
}

/**
 * sources = [{ id, device, alt, label }]
 * Devuelve [{ id, label, device, level, matches: [{ app, score }] }] y la lista de programas activos.
 */
async function identify(sources, seconds = 6) {
  const sessP = runSampler(seconds);
  // Se espera a que el muestreador empiece (compila el código de Windows) antes de medir las fuentes.
  await new Promise((r) => setTimeout(r, 1800));
  const srcP = Promise.all(sources.map((s) => sampleSource(s, seconds)));
  const [sess, levels] = await Promise.all([sessP, srcP]);
  const start = Math.max(sess[0].t, ...levels.filter((l) => l.length).map((l) => l[0].t));
  const end = Math.min(sess[sess.length - 1].t, ...levels.filter((l) => l.length).map((l) => l[l.length - 1].t));
  const n = Math.max(0, Math.floor((end - start) / STEP));
  if (n < 20) throw new Error('No hubo tiempo suficiente para comparar. Inténtalo de nuevo.');
  const apps = [...new Set(sess.flatMap((s) => Object.keys(s.peaks)))];
  const appSeries = Object.fromEntries(apps.map((a) => [a, onGrid(sess, start, n, (x) => x.peaks[a] || 0)]));
  const active = apps.filter((a) => Math.max(...appSeries[a]) > 0.01);
  return {
    apps: active.map((a) => ({ app: a, peak: Math.max(...appSeries[a]) })),
    sources: sources.map((s, k) => {
      const lv = onGrid(levels[k], start, n, (x) => x.v);
      const level = Math.max(...lv);
      // Se prueban desfases de hasta ±1,5 s: el audio tarda en pasar por Voicemeeter y las
      // dos mediciones no arrancan exactamente a la vez.
      const matches = active.map((a) => {
        let best = -1;
        for (let lag = -15; lag <= 15; lag++) {
          const x = lag >= 0 ? appSeries[a].slice(0, n - lag) : appSeries[a].slice(-lag);
          const y = lag >= 0 ? lv.slice(lag) : lv.slice(0, n + lag);
          best = Math.max(best, corr(x, y));
        }
        return { app: a, score: Math.round(best * 100) / 100 };
      }).sort((x, y) => y.score - x.score);
      return { id: s.id, label: s.label, device: s.device, level, matches };
    }),
  };
}

module.exports = { identify };
