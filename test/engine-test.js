'use strict';
// Prueba de extremo a extremo del motor de exportación: genera vídeos de muestra
// y comprueba duración, resolución, fps y tamaño de los resultados.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const engine = require('../src/engine');
const Core = require('../src/shared/core');

const OUT = path.join(__dirname, 'out');
const SAMPLES = path.join(OUT, 'samples');
fs.mkdirSync(SAMPLES, { recursive: true });
const b = engine.init({ cacheDir: path.join(OUT, 'cache') });
console.log(`FFmpeg: ${b.ffmpeg} (${b.version})\n`);

function gen(name, args) {
  const file = path.join(SAMPLES, name);
  if (!fs.existsSync(file)) execFileSync(b.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  return file;
}

const samples = {
  a: gen('a_720p30.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
  b: gen('b_1080p60.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=3', '-f', 'lavfi', '-i', 'sine=f=660:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
  c: gen('c_vertical25_noaudio.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']),
  d: gen('d_480p24.webm', ['-f', 'lavfi', '-i', 'mandelbrot=s=640x480:r=24', '-f', 'lavfi', '-i', 'sine=f=330:d=2',
    '-t', '2', '-c:v', 'libvpx-vp9', '-b:v', '500k', '-c:a', 'libopus', '-shortest']),
};

async function clipFor(file, props = {}) {
  const info = await engine.probe(file);
  return Object.assign({
    path: file, srcW: info.width, srcH: info.height, srcFps: info.fps, srcFpsStr: info.fpsStr,
    srcDuration: info.duration, srcSize: info.size, sar: info.sar, hasAudio: info.hasAudio,
    in: 0, out: info.duration,
  }, Core.defaultClipProps(), props);
}

function ffprobe(file) {
  // Los archivos de solo audio no tienen pista de vídeo.
  const out = execFileSync(engine.bin.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  if (!v) return { duration: Number(j.format.duration), acodec: a && a.codec_name, size: Number(j.format.size) };
  return { duration: Number(j.format.duration), width: v.width, height: v.height, fps: Core.parseFps(v.avg_frame_rate),
    vcodec: v.codec_name, acodec: a && a.codec_name, size: Number(j.format.size) };
}

let failures = 0;
function check(cond, msg) {
  console.log(`   ${cond ? '✔' : '✘'} ${msg}`);
  if (!cond) failures++;
}

async function job(name, clips, settings, expect) {
  const s = Core.normalizeSettings(settings);
  const ext = s.container;
  const outputPath = path.join(OUT, `${name}.${ext}`);
  process.stdout.write(`▶ ${name}\n`);
  const t0 = Date.now();
  try {
    const plan = Core.planOutput(clips, s);
    await engine.exportVideo({ clips, settings: s, outputPath }, null).promise;
    const r = ffprobe(outputPath);
    if (s.audioOnly) {
      console.log(`   solo audio · ${r.acodec} · ${r.duration.toFixed(2)} s · ${Core.formatBytes(r.size)}`);
      check(Math.abs(r.duration - plan.duration) < 0.15, `duración ≈ ${plan.duration.toFixed(2)} s`);
      if (expect) expect(r, plan);
      return;
    }
    console.log(`   ${r.width}x${r.height} · ${r.fps.toFixed(3)} fps · ${r.duration.toFixed(2)} s · ${Core.formatBytes(r.size)} · ${r.vcodec}/${r.acodec || '-'} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check(Math.abs(r.duration - plan.duration) < 0.15, `duración ≈ ${plan.duration.toFixed(2)} s`);
    check(r.width === plan.width && r.height === plan.height, `resolución ${plan.width}x${plan.height}`);
    // GIF guarda los tiempos en centésimas: 15 fps quedan en 16,7.
    check(Math.abs(r.fps - plan.fps) < (s.codec === 'gif' ? 2 : 0.01), `fps ${plan.fps.toFixed(3)}`);
    if (expect) expect(r, plan);
  } catch (e) {
    failures++;
    console.log(`   ✘ ERROR: ${e.message}`);
  }
}

(async () => {
  const caps = await engine.capabilities();
  console.log('Códecs:', JSON.stringify(caps.sw), 'GPU:', Object.keys(caps.hw).join(', ') || 'ninguna', '\n');

  // 1. Unir clips heterogéneos con recortes, velocidad, color, rotación, encuadre y fundidos.
  const merged = [
    await clipFor(samples.a, { in: 0.5, out: 3.5, color: { ...Core.defaultColor(), preset: 'cinema', saturation: 20 }, fadeIn: 0.5 }),
    await clipFor(samples.b, { speed: 2, volume: 0.5 }),
    await clipFor(samples.c, { rotate: 90, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, flipH: true }),
    await clipFor(samples.d, { speed: 0.5, color: { ...Core.defaultColor(), preset: 'bw', vignette: 50, sharpen: 30 }, fadeOut: 0.5 }),
  ];
  await job('01_merge_1080p30_crf', merged, { format: 'mp4-h264', resolution: '1080', aspect: '16:9', fps: '30', crf: 23, preset: 'veryfast' },
    (r) => check(r.acodec === 'aac', 'audio AAC presente'));

  // 2. Compresión por tamaño objetivo (2 MB, dos pasadas).
  await job('02_size_2MB_twopass', merged, { format: 'mp4-h264', resolution: '720', aspect: '16:9', rateMode: 'size', targetMB: 2, preset: 'veryfast' },
    (r) => check(r.size <= 2 * Core.MB && r.size > 1.4 * Core.MB, `tamaño ≤ 2 MB y cercano (${Core.formatBytes(r.size)})`));

  // 3. Compresión por porcentaje con H.265.
  const single = [await clipFor(samples.b)];
  const src = fs.statSync(samples.b).size;
  await job('03_percent40_h265', single, { format: 'mp4-h265', rateMode: 'percent', percent: 40, preset: 'fast' },
    (r) => check(r.size <= src * 0.42, `≤ 40% de ${Core.formatBytes(src)} (${Core.formatBytes(r.size)})`));

  // 4. Cambio de fps con mezcla e interpolación de movimiento.
  const short = [await clipFor(samples.a, { in: 0, out: 1.5 })];
  await job('04_fps60_blend', short, { format: 'mp4-h264', fps: '60', fpsMode: 'blend', preset: 'ultrafast' });
  await job('05_fps60_mci', short, { format: 'mp4-h264', resolution: '360', fps: '60', fpsMode: 'mci', preset: 'ultrafast' });
  await job('06_fps23976_vertical', merged.slice(1, 3), { format: 'mp4-h264', resolution: '720', aspect: '9:16', fit: 'cover', fps: '24000/1001', preset: 'ultrafast' });

  // 5. Otros formatos.
  await job('07_webm_vp9_bitrate', short, { format: 'webm-vp9', rateMode: 'bitrate', bitrateKbps: 800, preset: 'ultrafast' },
    (r) => check(r.vcodec === 'vp9' && r.acodec === 'opus', 'VP9 + Opus'));
  await job('08_prores', short, { format: 'mov-prores', resolution: '720' }, (r) => check(r.vcodec === 'prores', 'ProRes'));
  await job('09_mkv_noaudio', short, { format: 'mkv-h264', audio: false, preset: 'ultrafast' }, (r) => check(!r.acodec, 'sin audio'));
  await job('10_av1', short, { format: 'mp4-av1', resolution: '360', crf: 40, preset: 'ultrafast' }, (r) => check(r.vcodec === 'av1', 'AV1'));
  await job('11_vp9_size_twopass', merged, { format: 'webm-vp9', resolution: '480', aspect: '16:9', rateMode: 'size', targetMB: 1, preset: 'ultrafast' },
    (r) => check(r.size <= 1 * Core.MB, `tamaño ≤ 1 MB (${Core.formatBytes(r.size)})`));

  // 6. Aceleración por GPU (si existe).
  for (const hw of Object.keys(caps.hw)) {
    await job(`12_gpu_${hw}_crf`, merged, { format: 'mp4-h264', resolution: '720', aspect: '16:9', hw, crf: 23 });
    await job(`13_gpu_${hw}_size`, merged, { format: 'mp4-h264', resolution: '720', aspect: '16:9', hw, rateMode: 'size', targetMB: 2 },
      (r) => check(r.size <= 2 * Core.MB, `tamaño ≤ 2 MB (${Core.formatBytes(r.size)})`));
    if (caps.hw[hw].h265) await job(`14_gpu_${hw}_h265`, short, { format: 'mp4-h265', hw, crf: 26 }, (r) => check(r.vcodec === 'hevc', 'HEVC por GPU'));
  }

  // 7. Transiciones, textos superpuestos y pistas de música.
  const music = gen('music.mp3', ['-f', 'lavfi', '-i', 'sine=f=220:d=8', '-f', 'lavfi', '-i', 'sine=f=330:d=8',
    '-filter_complex', 'amerge=inputs=2', '-c:a', 'libmp3lame', '-b:a', '192k']);
  const textPng = gen('text.png', ['-f', 'lavfi', '-i', "color=c=red:s=1280x720,format=rgba,geq=r='255':g='0':b='0':a='if(between(Y,560,650)*between(X,200,1080),210,0)'",
    '-frames:v', '1']);
  const mInfo = await engine.probe(music);
  check(mInfo.kind === 'audio' && Math.abs(mInfo.duration - 8) < 0.1, `MP3 reconocido como audio (${mInfo.duration.toFixed(2)} s)`);
  const withTrans = [
    await clipFor(samples.a, { transOut: { type: 'fade', duration: 1 } }),
    await clipFor(samples.b, { transOut: { type: 'wipeleft', duration: 0.8 } }),
    await clipFor(samples.c),
    await clipFor(samples.d, { speed: 0.5 }),
  ];
  withTrans[2].transOut = { type: 'circleopen', duration: 0.5 };
  const texts = [{ png: fs.readFileSync(textPng), start: 1, duration: 3, fadeIn: 0.3, fadeOut: 0.3 }];
  const audios = [
    { path: music, start: 0.5, in: 1, out: 6, volume: 0.6, fadeIn: 1, fadeOut: 1 },
    { path: music, start: 7, in: 0, out: 8, volume: 1.4, fadeIn: 0, fadeOut: 2 },
  ];
  const tJob = async (name, settings, extra) => {
    const s = Core.normalizeSettings(settings);
    const outputPath = path.join(OUT, `${name}.mp4`);
    console.log(`▶ ${name}`);
    try {
      const plan = Core.planOutput(withTrans, s);
      await engine.exportVideo({ clips: withTrans, settings: s, outputPath, ...extra }, null).promise;
      const r = ffprobe(outputPath);
      console.log(`   ${r.width}x${r.height} · ${r.fps.toFixed(3)} fps · ${r.duration.toFixed(2)} s · ${Core.formatBytes(r.size)}`);
      check(Math.abs(r.duration - plan.duration) < 0.15, `duración con transiciones ≈ ${plan.duration.toFixed(2)} s`);
      check(r.width === plan.width && Math.abs(r.fps - plan.fps) < 0.01, 'resolución y fps');
    } catch (e) { failures++; console.log(`   ✘ ERROR: ${e.message}`); }
  };
  await tJob('15_transiciones_textos_musica', { format: 'mp4-h264', resolution: '720', aspect: '16:9', fps: '30', preset: 'ultrafast' }, { texts, audios });
  await tJob('16_transiciones_2pasadas', { format: 'mp4-h264', resolution: '720', aspect: '16:9', rateMode: 'size', targetMB: 1.5, preset: 'ultrafast' }, { texts, audios },
  );

  // 8. Audio Studio: codificación a MP3 y a vídeo con forma de onda.
  const wavBuf = execFileSync(b.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', music, '-t', '4', '-f', 'wav', '-']);
  for (const [fmt, cover] of [['mp3', null], ['flac', null], ['mp4', null], ['mp4', textPng]]) {
    const out = path.join(OUT, `17_studio_${fmt}${cover ? '_cover' : ''}.${fmt}`);
    console.log(`▶ Audio Studio → ${path.basename(out)}`);
    try {
      await engine.encodeAudio({ wav: wavBuf, outputPath: out, format: fmt, kbps: 320, title: 'Prueba (slowed)', cover, duration: 4 }).promise;
      const r = ffprobe(out);
      check(Math.abs(r.duration - 4) < 0.2, `duración 4 s (${r.duration.toFixed(2)})`);
    } catch (e) { failures++; console.log(`   ✘ ERROR: ${e.message}`); }
  }

  // 9. Cortador de audio.
  const cutCases = [
    ['18_cut_copy.mp3', { input: music, acodec: 'mp3', segments: [{ start: 1, end: 4 }], format: 'original' }, 3, true],
    ['19_cut_join_fades.mp3', { input: music, acodec: 'mp3', segments: [{ start: 0, end: 2 }, { start: 5, end: 7.5 }], fadeIn: 0.5, fadeOut: 1, format: 'mp3', kbps: 192 }, 4.5, false],
    ['20_cut_from_video.m4a', { input: samples.a, acodec: 'aac', segments: [{ start: 0.5, end: 3 }], format: 'original' }, 2.5, true],
    ['21_cut_normalize.wav', { input: music, acodec: 'mp3', segments: [{ start: 2, end: 6 }], normalize: true, gainDb: 3, format: 'wav' }, 4, false],
  ];
  for (const [name, o, dur, copy] of cutCases) {
    const out = path.join(OUT, name);
    console.log(`▶ Cortador → ${name}`);
    try {
      const r = await engine.cutAudio({ ...o, outputPath: out }).promise;
      const p = ffprobe(out);
      check(Math.abs(p.duration - dur) < 0.1, `duración ${dur} s (${p.duration.toFixed(2)})`);
      check(r.copy === copy, copy ? 'copia directa sin recodificar' : 'recodificado');
    } catch (e) { failures++; console.log(`   ✘ ERROR: ${e.message}`); }
  }

  // 10. Fuentes de una grabación (varias pistas con nombre) y estirado a 1080p.
  const probeRaw = (f) => { const j = JSON.parse(execFileSync(engine.bin.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f])); return { streams: j.streams, duration: Number(j.format.duration) }; };
  console.log('▶ grabación con 3 pistas → exportar fuentes y estirar');
  const multi = path.join(OUT, '22_multitrack.mp4');
  execFileSync(b.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1440x1044:rate=60:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata:s:a:0', 'handler_name=Mezcla', '-metadata:s:a:1', 'handler_name=Mic', '-metadata:s:a:2', 'handler_name=Juego', multi]);
  try {
    const mi = await engine.probe(multi);
    check(mi.audioTracks.length === 3 && mi.audioTracks.map((t) => t.name).join(',') === 'Mezcla,Mic,Juego', `pistas con nombre (${mi.audioTracks.map((t) => t.name).join(', ')})`);
    const dir = path.join(OUT, '23_fuentes');
    const r = await engine.exportTracks({ input: multi, outDir: dir, baseName: 'rec', tracks: mi.audioTracks.slice(1), video: true, format: 'wav', duration: mi.duration }).promise;
    check(r.paths.length === 3, `3 archivos (${r.paths.map((p) => path.basename(p)).join(', ')})`);
    const vid = probeRaw(r.paths[0]);
    check(vid.streams.every((s) => s.codec_type === 'video'), 'vídeo sin audio');
    const wav = probeRaw(r.paths[1]);
    check(wav.streams[0].codec_name === 'pcm_s16le' && Math.abs(wav.duration - 3) < 0.1, 'pista en WAV de 3 s');
    const copy = await engine.exportTracks({ input: multi, outDir: dir, baseName: 'rec', tracks: [mi.audioTracks[1]], format: 'original', duration: mi.duration }).promise;
    check(path.extname(copy.paths[0]) === '.m4a' && probeRaw(copy.paths[0]).streams[0].codec_name === 'aac', 'formato original copiado a .m4a');
    const st = await engine.stretchVideo({ input: multi, duration: mi.duration }).promise;
    const sp = probeRaw(st.path);
    const v = sp.streams.find((s) => s.codec_type === 'video');
    check(v.width === 1920 && v.height === 1080 && v.display_aspect_ratio === '16:9', `estirado 1920×1080 16:9 (${v.width}×${v.height} ${v.display_aspect_ratio})`);
    check(sp.streams.filter((s) => s.codec_type === 'audio').length === 3, 'conserva las 3 pistas de audio');
    check(/_1080p_Estirado( \(\d+\))?\.mp4$/.test(st.path), 'nombre como escalador.bat');
  } catch (e) { failures++; console.log(`   ✘ ERROR: ${e.message}`); }

  // 10b. Formatos configurables: solo audio, GIF, otros contenedores y códecs de audio.
  for (const [fmt, codec] of [['audio-mp3', 'mp3'], ['audio-m4a', 'aac'], ['audio-ogg', 'opus'], ['audio-vorbis', 'vorbis'], ['audio-opus', 'opus'], ['audio-flac', 'flac'], ['audio-wav', 'pcm_s16le']]) {
    await job(`12_${fmt}`, short, { format: fmt, audioKbps: 128 }, (r) => check(r.acodec === codec, `audio ${codec}`));
  }
  await job('13_gif', short, { format: 'gif', resolution: '360', fps: '15' }, (r) => check(r.vcodec === 'gif' && !r.acodec, 'GIF sin audio'));
  await job('14_avi_mp3', short, { format: 'avi-h264', preset: 'ultrafast' }, (r) => check(r.acodec === 'mp3', 'AVI con MP3'));
  await job('15_mkv_h265_flac_mono', short, { format: 'mkv-h265', acodec: 'flac', channels: '1', sampleRate: '44100', preset: 'ultrafast' }, (r) => {
    const a = JSON.parse(execFileSync(engine.bin.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels,sample_rate', '-of', 'json', path.join(OUT, '15_mkv_h265_flac_mono.mkv')])).streams[0];
    check(a.codec_name === 'flac' && a.channels === 1 && a.sample_rate === '44100', `FLAC mono 44,1 kHz (${a.codec_name} ${a.channels} ${a.sample_rate})`);
  });
  await job('16_mp4_opus_auto_hw', short, { format: 'mp4-h264', acodec: 'opus', hw: 'auto', preset: 'fast' }, (r) => check(r.acodec === 'opus', 'MP4 con Opus'));
  await job('17_mov_alac', short, { format: 'mov-h264', acodec: 'alac', preset: 'ultrafast' }, (r) => check(r.acodec === 'alac', 'MOV con ALAC'));
  await job('18_webm_aac_cae_a_opus', short, { format: 'webm-vp9', acodec: 'aac', preset: 'ultrafast', rateMode: 'bitrate', bitrateKbps: 600 }, (r) => check(r.acodec === 'opus', 'WebM no admite AAC: usa Opus'));

  // 11. Miniaturas, forma de onda y proxy.
  console.log('▶ miniaturas / onda / proxy');
  const info = await engine.probe(samples.d);
  const th = await engine.thumbnails(samples.d, info);
  check(!!th.poster && !!th.strip, 'póster y tira de miniaturas');
  check(!!(await engine.waveform(samples.d)), 'forma de onda');
  check(!!(await engine.proxy(samples.d, info)), 'proxy de previsualización');

  // Vista previa fluida: copia de 720p con una imagen clave cada 15 y audio aparte.
  const infoB = await engine.probe(samples.b);
  const fileOf = (url) => decodeURIComponent(new URL(url).pathname.slice(1));
  const edit = fileOf(await engine.editProxy(samples.b, infoB));
  const pe = ffprobe(edit);
  const keys = execFileSync(engine.bin.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', edit])
    .toString().trim().split(/\r?\n/).map(parseFloat);
  check(pe.height === 720 && pe.width === 1280 && Math.abs(pe.fps - 60) < 0.5 && Math.abs(pe.duration - infoB.duration) < 0.1,
    `copia de vista previa 720p60 (${pe.width}×${pe.height}, ${pe.fps} fps)`);
  check(keys.length >= 10 && Math.max(...keys.slice(1).map((k, i) => k - keys[i])) <= 0.26, `copia de vista previa con imagen clave cada 0,25 s (${keys.length} claves)`);
  const aud = fileOf(await engine.audioProxy(samples.b, infoB));
  const pa = ffprobe(aud);
  check(pa.acodec === 'aac' && pa.width === undefined && Math.abs(pa.duration - infoB.duration) < 0.1, 'audio aparte de un vídeo (sin imagen)');

  console.log(failures ? `\n${failures} comprobación(es) fallida(s)` : '\nTodo correcto ✔');
  process.exit(failures ? 1 : 0);
})();
