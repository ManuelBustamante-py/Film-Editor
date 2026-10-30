/*
 * Núcleo compartido entre la interfaz (renderer) y el motor de exportación (main).
 * Contiene la matemática de color, el cálculo de resolución / fps / bitrate y
 * utilidades de formato. Al ser el mismo código en ambos lados, lo que se ve en
 * la vista previa coincide con lo que se exporta.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MB = 1024 * 1024;

  // ---------------------------------------------------------------------------
  // Matrices de color (3x3, aplicadas sobre RGB)
  // ---------------------------------------------------------------------------
  const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const LUMA = [0.2126, 0.7152, 0.0722];
  const SEPIA = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];

  function mul(a, b) {
    const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    return r;
  }

  // Mezcla entre la identidad y la matriz dada (k = 0 → identidad, k = 1 → m).
  function towards(m, k) {
    return m.map((row, i) => row.map((v, j) => (i === j ? 1 : 0) + k * (v - (i === j ? 1 : 0))));
  }

  function saturationMatrix(s) {
    const [r, g, b] = LUMA;
    return [
      [r + (1 - r) * s, g - g * s, b - b * s],
      [r - r * s, g + (1 - g) * s, b - b * s],
      [r - r * s, g - g * s, b + (1 - b) * s],
    ];
  }

  function hueMatrix(deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return [
      [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
      [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
      [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ];
  }

  function isIdentity(m) {
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        if (Math.abs(m[i][j] - (i === j ? 1 : 0)) > 1e-4) return false;
    return true;
  }

  const COLOR_PRESETS = [
    { id: 'none', label: 'Original' },
    { id: 'vivid', label: 'Vívido', matrix: saturationMatrix(1.45), contrast: 10 },
    { id: 'warm', label: 'Cálido', matrix: [[1.12, 0.02, 0], [0, 1.03, 0], [0, 0, 0.84]], brightness: 2 },
    { id: 'cool', label: 'Frío', matrix: [[0.86, 0, 0.02], [0, 1.0, 0.03], [0, 0.02, 1.16]] },
    { id: 'cinema', label: 'Cine', matrix: [[1.08, 0.04, -0.06], [-0.02, 1.02, 0.02], [-0.06, 0.08, 1.02]], contrast: 15, brightness: -2 },
    { id: 'vintage', label: 'Vintage', matrix: towards(SEPIA, 0.45), contrast: -12, brightness: 4 },
    { id: 'faded', label: 'Desvaído', matrix: saturationMatrix(0.6), contrast: -25, brightness: 5 },
    { id: 'dramatic', label: 'Dramático', matrix: saturationMatrix(0.75), contrast: 40, brightness: -3 },
    { id: 'emerald', label: 'Esmeralda', matrix: [[0.9, 0.05, 0], [0.02, 1.08, 0], [0, 0.06, 0.98]], contrast: 8 },
    { id: 'bw', label: 'Blanco y negro', matrix: saturationMatrix(0) },
    { id: 'noir', label: 'Noir', matrix: saturationMatrix(0), contrast: 45, brightness: -4 },
    { id: 'sepia', label: 'Sepia', matrix: SEPIA },
  ];
  const PRESET_MAP = Object.fromEntries(COLOR_PRESETS.map((p) => [p.id, p]));

  function defaultColor() {
    return {
      preset: 'none', intensity: 100,
      exposure: 0, brightness: 0, contrast: 0, saturation: 0,
      temperature: 0, tint: 0, hue: 0, sharpen: 0, vignette: 0,
    };
  }

  function isDefaultColor(c) {
    if (!c) return true;
    const d = defaultColor();
    return Object.keys(d).every((k) => k === 'intensity' || c[k] === d[k]);
  }

  // Convierte los ajustes de la interfaz en parámetros físicos.
  function resolveColor(color) {
    const c = Object.assign(defaultColor(), color || {});
    const p = PRESET_MAP[c.preset] || PRESET_MAP.none;
    const k = c.intensity / 100;
    let m = p.matrix ? towards(p.matrix, k) : IDENTITY;
    m = mul(saturationMatrix(1 + c.saturation / 100), m);
    if (c.hue) m = mul(hueMatrix(c.hue), m);
    const t = c.temperature / 100, ti = c.tint / 100;
    if (t || ti) {
      const d = [[1 + 0.16 * t + 0.04 * ti, 0, 0], [0, 1 - 0.1 * ti, 0], [0, 0, 1 - 0.16 * t + 0.04 * ti]];
      m = mul(d, m);
    }
    const contrast = Math.max(0, 1 + (c.contrast + k * (p.contrast || 0)) / 100);
    const brightness = ((c.brightness + k * (p.brightness || 0)) / 100) * 0.35;
    const gamma = Math.pow(2, c.exposure / 100);
    return { contrast, brightness, gamma, matrix: m, sharpen: c.sharpen / 100, vignette: c.vignette / 100 };
  }

  function num(x, d = 4) {
    return String(Number(Number(x).toFixed(d)));
  }

  // Filtros FFmpeg equivalentes a la vista previa.
  // eq aplica: v = contraste·(v − 0.5) + 0.5 + brillo, luego v^(1/gamma).
  function ffmpegColorFilters(color) {
    const r = resolveColor(color);
    const f = [];
    if (Math.abs(r.contrast - 1) > 1e-3 || Math.abs(r.brightness) > 1e-3 || Math.abs(r.gamma - 1) > 1e-3)
      f.push(`eq=contrast=${num(r.contrast)}:brightness=${num(r.brightness)}:gamma=${num(r.gamma)}`);
    if (!isIdentity(r.matrix)) {
      const n = ['r', 'g', 'b'];
      const parts = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) parts.push(`${n[i]}${n[j]}=${num(r.matrix[i][j])}`);
      f.push(`colorchannelmixer=${parts.join(':')}`);
    }
    if (r.sharpen > 0) f.push(`unsharp=5:5:${num(r.sharpen * 1.6, 3)}:5:5:0`);
    if (r.vignette > 0) f.push(`vignette=angle=${num(0.25 + r.vignette * 0.85, 3)}`);
    return f;
  }

  // Parámetros para construir el filtro SVG de la vista previa.
  function svgFilterSpec(color) {
    const r = resolveColor(color);
    const m = r.matrix;
    return {
      slope: r.contrast,
      intercept: 0.5 - 0.5 * r.contrast + r.brightness,
      exponent: 1 / r.gamma,
      matrix: [...m[0], 0, 0, ...m[1], 0, 0, ...m[2], 0, 0, 0, 0, 0, 1, 0].map((v) => num(v, 5)).join(' '),
      sharpen: r.sharpen,
      vignette: r.vignette,
    };
  }

  function svgFilterMarkup(id, color) {
    const s = svgFilterSpec(color);
    const fn = (t) => `<feFunc${t} type="linear" slope="${num(s.slope)}" intercept="${num(s.intercept)}"/>`;
    const gm = (t) => `<feFunc${t} type="gamma" amplitude="1" exponent="${num(s.exponent)}" offset="0"/>`;
    let out = `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">`;
    out += `<feComponentTransfer>${fn('R')}${fn('G')}${fn('B')}</feComponentTransfer>`;
    if (Math.abs(s.exponent - 1) > 1e-3) out += `<feComponentTransfer>${gm('R')}${gm('G')}${gm('B')}</feComponentTransfer>`;
    out += `<feColorMatrix type="matrix" values="${s.matrix}"/>`;
    if (s.sharpen > 0) {
      const k = num(s.sharpen * 0.9, 3), c = num(1 + 4 * s.sharpen * 0.9, 3);
      out += `<feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -${k} 0 -${k} ${c} -${k} 0 -${k} 0"/>`;
    }
    return out + '</filter>';
  }

  // ---------------------------------------------------------------------------
  // Formatos, resoluciones, fps
  // ---------------------------------------------------------------------------
  const FORMATS = [
    { id: 'mp4-h264', label: 'MP4 · H.264', hint: 'Máxima compatibilidad', container: 'mp4', codec: 'h264' },
    { id: 'mp4-h265', label: 'MP4 · H.265 / HEVC', hint: 'Mejor compresión', container: 'mp4', codec: 'h265' },
    { id: 'mp4-av1', label: 'MP4 · AV1', hint: 'Compresión de última generación', container: 'mp4', codec: 'av1' },
    { id: 'webm-vp9', label: 'WebM · VP9', hint: 'Ideal para web', container: 'webm', codec: 'vp9' },
    { id: 'mkv-h264', label: 'MKV · H.264', hint: 'Contenedor flexible', container: 'mkv', codec: 'h264' },
    { id: 'mov-h264', label: 'MOV · H.264', hint: 'Apple / QuickTime', container: 'mov', codec: 'h264' },
    { id: 'mov-prores', label: 'MOV · ProRes 422 HQ', hint: 'Intermedio para edición profesional', container: 'mov', codec: 'prores' },
    { id: 'mkv-h265', label: 'MKV · H.265 / HEVC', hint: 'Contenedor flexible y ligero', container: 'mkv', codec: 'h265' },
    { id: 'webm-av1', label: 'WebM · AV1', hint: 'Web de última generación', container: 'webm', codec: 'av1' },
    { id: 'avi-h264', label: 'AVI · H.264', hint: 'Programas antiguos', container: 'avi', codec: 'h264' },
    { id: 'gif', label: 'GIF animado', hint: 'Para chats y redes (sin audio)', container: 'gif', codec: 'gif' },
    // Solo audio: el sonido de la línea de tiempo, sin imagen.
    { id: 'audio-mp3', label: 'Solo audio · MP3', hint: 'Compatible con todo', container: 'mp3', codec: 'h264', audioOnly: true, aformat: 'mp3' },
    { id: 'audio-m4a', label: 'Solo audio · M4A (AAC)', hint: 'Buena calidad por MB', container: 'm4a', codec: 'h264', audioOnly: true, aformat: 'm4a' },
    { id: 'audio-ogg', label: 'Solo audio · OGG (Opus)', hint: 'El más eficiente', container: 'ogg', codec: 'h264', audioOnly: true, aformat: 'ogg' },
    { id: 'audio-vorbis', label: 'Solo audio · OGG (Vorbis)', hint: 'OGG clásico', container: 'ogg', codec: 'h264', audioOnly: true, aformat: 'vorbis' },
    { id: 'audio-opus', label: 'Solo audio · OPUS', hint: 'Voz y música a bajo bitrate', container: 'opus', codec: 'h264', audioOnly: true, aformat: 'opus' },
    { id: 'audio-flac', label: 'Solo audio · FLAC', hint: 'Sin pérdida', container: 'flac', codec: 'h264', audioOnly: true, aformat: 'flac' },
    { id: 'audio-wav', label: 'Solo audio · WAV', hint: 'Sin compresión', container: 'wav', codec: 'h264', audioOnly: true, aformat: 'wav' },
  ];
  const FORMAT_MAP = Object.fromEntries(FORMATS.map((f) => [f.id, f]));

  const CODECS = {
    h264: { label: 'H.264', crf: { min: 0, max: 51, def: 20 }, twoPass: true, efficiency: 1, margin: 0.965 },
    h265: { label: 'H.265', crf: { min: 0, max: 51, def: 24 }, twoPass: true, efficiency: 1.5, margin: 0.96 },
    vp9: { label: 'VP9', crf: { min: 0, max: 63, def: 32 }, twoPass: true, efficiency: 1.4, margin: 0.92 },
    av1: { label: 'AV1', crf: { min: 0, max: 63, def: 32 }, twoPass: false, efficiency: 1.8, margin: 0.9 },
    prores: { label: 'ProRes', fixedQuality: true, efficiency: 1 },
    gif: { label: 'GIF', fixedQuality: true, efficiency: 1 },
  };

  // Códecs de audio para los vídeos, con los contenedores que los admiten.
  const AUDIO_CODECS = {
    auto: { label: 'Automático (el mejor para el formato)' },
    aac: { label: 'AAC', containers: ['mp4', 'mov', 'mkv', 'avi'], kbps: true },
    mp3: { label: 'MP3', containers: ['mp4', 'mkv', 'avi', 'mov'], kbps: true },
    opus: { label: 'Opus', containers: ['mp4', 'mkv', 'webm'], kbps: true },
    vorbis: { label: 'Vorbis', containers: ['mkv', 'webm'], kbps: true },
    ac3: { label: 'AC3 (Dolby Digital)', containers: ['mp4', 'mkv', 'mov', 'avi'], kbps: true },
    flac: { label: 'FLAC (sin pérdida)', containers: ['mp4', 'mkv'] },
    alac: { label: 'ALAC (sin pérdida)', containers: ['mov', 'mp4', 'mkv'] },
    pcm: { label: 'PCM (sin compresión)', containers: ['mov', 'mkv', 'avi'] },
  };
  function defaultAudioCodec(container, codec) {
    if (codec === 'prores') return 'pcm';
    return { webm: 'opus', avi: 'mp3' }[container] || 'aac';
  }
  // Códec de audio efectivo (el elegido si el contenedor lo admite; si no, el natural).
  function audioCodecFor(s) {
    const c = AUDIO_CODECS[s.acodec];
    if (c && c.containers && c.containers.includes(s.container)) return s.acodec;
    return defaultAudioCodec(s.container, s.codec);
  }
  const SAMPLE_RATES = [
    { id: 'original', label: 'Original' }, { id: '44100', label: '44,1 kHz' }, { id: '48000', label: '48 kHz' }, { id: '96000', label: '96 kHz' },
  ];
  const CHANNELS = [{ id: 'original', label: 'Original' }, { id: '2', label: 'Estéreo' }, { id: '1', label: 'Mono' }];

  const RESOLUTIONS = [
    { id: 'original', label: 'Original' },
    { id: '2160', label: '4K · 2160p' },
    { id: '1440', label: '2K · 1440p' },
    { id: '1080', label: 'Full HD · 1080p' },
    { id: '720', label: 'HD · 720p' },
    { id: '540', label: '540p' },
    { id: '480', label: 'SD · 480p' },
    { id: '360', label: '360p' },
    { id: 'custom', label: 'Personalizada…' },
  ];

  const FPS_OPTIONS = [
    { id: 'original', label: 'Original' },
    { id: '24000/1001', label: '23.976' },
    { id: '24', label: '24' },
    { id: '25', label: '25' },
    { id: '30000/1001', label: '29.97' },
    { id: '30', label: '30' },
    { id: '48', label: '48' },
    { id: '50', label: '50' },
    { id: '60000/1001', label: '59.94' },
    { id: '60', label: '60' },
    { id: '90', label: '90' },
    { id: '100', label: '100' },
    { id: '120', label: '120' },
    { id: '144', label: '144' },
    { id: '240', label: '240' },
    { id: 'custom', label: 'Personalizado…' },
  ];

  const ASPECTS = [
    { id: 'auto', label: 'Auto (1.er clip)' },
    { id: '16:9', label: '16:9 Horizontal' },
    { id: '9:16', label: '9:16 Vertical' },
    { id: '1:1', label: '1:1 Cuadrado' },
    { id: '4:3', label: '4:3 Clásico' },
    { id: '4:5', label: '4:5 Retrato' },
    { id: '21:9', label: '21:9 Panorámico' },
  ];

  const PRESETS = [
    { id: 'ultrafast', label: 'Ultrarrápida' },
    { id: 'superfast', label: 'Superrápida' },
    { id: 'veryfast', label: 'Muy rápida' },
    { id: 'faster', label: 'Más rápida' },
    { id: 'fast', label: 'Rápida' },
    { id: 'medium', label: 'Equilibrada' },
    { id: 'slow', label: 'Lenta (mejor calidad)' },
    { id: 'slower', label: 'Más lenta' },
    { id: 'veryslow', label: 'Muy lenta (máxima calidad)' },
  ];

  function defaultSettings() {
    return {
      aspect: 'auto', fit: 'contain',
      format: 'mp4-h264', resolution: 'original', customW: 1920, customH: 1080,
      fps: 'original', customFps: 30, fpsMode: 'dup',
      rateMode: 'crf', crf: 20, targetMB: 50, percent: 50, bitrateKbps: 8000,
      preset: 'medium', hw: 'auto', twoPass: true, autoDownscale: false,
      audio: true, audioKbps: 192, acodec: 'auto', sampleRate: 'original', channels: 'original',
    };
  }

  function normalizeSettings(s) {
    const out = Object.assign(defaultSettings(), s || {});
    const f = FORMAT_MAP[out.format] || FORMAT_MAP['mp4-h264'];
    out.container = f.container;
    out.codec = f.codec;
    out.audioOnly = !!f.audioOnly;
    out.aformat = f.aformat || null;
    if (out.audioOnly) out.audio = true;
    if (out.codec === 'gif') out.audio = false;
    return out;
  }

  function even(n) {
    return Math.max(2, Math.round(n / 2) * 2);
  }

  function parseFps(v) {
    if (typeof v === 'number') return v;
    const s = String(v || '');
    if (s.includes('/')) {
      const [a, b] = s.split('/').map(Number);
      return b ? a / b : 0;
    }
    return Number(s) || 0;
  }

  // Tamaño del contenido del clip tras rotación y encuadre (en píxeles de origen).
  function effectiveSize(c) {
    let w = c.srcW, h = c.srcH;
    if ((c.rotate || 0) % 180) [w, h] = [h, w];
    if (c.crop) { w *= c.crop.w; h *= c.crop.h; }
    return { w, h };
  }

  function canvasAspect(aspectId, clips) {
    if (aspectId && aspectId !== 'auto') {
      const [a, b] = aspectId.split(':').map(Number);
      return a / b;
    }
    if (clips.length) {
      const s = effectiveSize(clips[0]);
      return s.w / s.h;
    }
    return 16 / 9;
  }

  function dimsForShortSide(short, aspect) {
    return aspect >= 1
      ? { width: even(short * aspect), height: even(short) }
      : { width: even(short), height: even(short / aspect) };
  }

  function outputDimensions(s, clips) {
    const aspect = canvasAspect(s.aspect, clips);
    let d;
    if (s.resolution === 'custom') d = { width: even(s.customW || 1920), height: even(s.customH || 1080) };
    else if (s.resolution === 'original' || !s.resolution) {
      if (!clips.length) d = dimsForShortSide(1080, aspect);
      else {
        const e = effectiveSize(clips[0]);
        d = !s.aspect || s.aspect === 'auto'
          ? { width: even(e.w), height: even(e.h) }
          : dimsForShortSide(Math.min(e.w, e.h), aspect);
      }
    } else d = dimsForShortSide(Number(s.resolution), aspect);
    d.width = Math.min(d.width, 8192);
    d.height = Math.min(d.height, 8192);
    return d;
  }

  function outputFps(s, clips) {
    let v;
    if (s.fps === 'custom') v = String(s.customFps || 30);
    else if (!s.fps || s.fps === 'original') v = clips.length ? clips[0].srcFpsStr || String(clips[0].srcFps) : '30';
    else v = s.fps;
    const n = parseFps(v);
    if (!(n >= 1 && n <= 480)) v = '30';
    return v;
  }

  function clipDuration(c) {
    return (c.out - c.in) / (c.speed || 1);
  }

  // ---------------------------------------------------------------------------
  // Transiciones y disposición de la secuencia de vídeo
  // ---------------------------------------------------------------------------
  const TRANSITIONS = [
    { id: 'fade', label: 'Disolver' },
    { id: 'fadeblack', label: 'Fundido a negro' },
    { id: 'fadewhite', label: 'Destello blanco' },
    { id: 'wipeleft', label: 'Barrido ←' },
    { id: 'wiperight', label: 'Barrido →' },
    { id: 'slideleft', label: 'Deslizar ←' },
    { id: 'slideright', label: 'Deslizar →' },
    { id: 'circleopen', label: 'Círculo' },
  ];
  const TRANSITION_MAP = Object.fromEntries(TRANSITIONS.map((t) => [t.id, t]));

  // Duración efectiva de la transición entre el clip i y el i+1 (limitada para
  // que las dos transiciones de un clip nunca se solapen).
  function transitionDur(clips, i) {
    const t = clips[i] && clips[i].transOut;
    if (!t || !TRANSITION_MAP[t.type] || i >= clips.length - 1) return 0;
    const a = clipDuration(clips[i]), b = clipDuration(clips[i + 1]);
    return Math.max(0, Math.min(t.duration || 0, a * 0.45, b * 0.45));
  }

  function sequenceLayout(clips) {
    let end = 0;
    const items = clips.map((c, i) => {
      const dur = clipDuration(c);
      const tIn = i > 0 ? transitionDur(clips, i - 1) : 0;
      const start = i === 0 ? 0 : end - tIn;
      end = start + dur;
      return { i, start, dur, tIn, tOut: transitionDur(clips, i), transIn: i > 0 && tIn > 0 ? clips[i - 1].transOut.type : null };
    });
    return { items, total: end };
  }

  // ---------------------------------------------------------------------------
  // Textos y clips de audio
  // ---------------------------------------------------------------------------
  const TEXT_FONTS = ['Segoe UI', 'Bahnschrift', 'Arial', 'Arial Black', 'Impact', 'Georgia', 'Times New Roman',
    'Verdana', 'Trebuchet MS', 'Consolas', 'Comic Sans MS', 'Segoe Script', 'Gabriola'];

  function defaultText() {
    return {
      text: 'Tu texto aquí', font: 'Segoe UI', size: 8, color: '#ffffff', bold: true, italic: false, align: 'center',
      x: 0.5, y: 0.82, box: false, boxColor: '#000000', boxOpacity: 55, outline: 0, outlineColor: '#000000',
      shadow: true, fadeIn: 0.3, fadeOut: 0.3, start: 0, duration: 3,
    };
  }

  // Formatos de salida del cortador de audio.
  const AUDIO_FORMATS = [
    { id: 'original', label: 'Original (sin recodificar si es posible)' },
    { id: 'mp3', label: 'MP3', ext: 'mp3', kbps: true },
    { id: 'm4a', label: 'M4A · AAC', ext: 'm4a', kbps: true },
    { id: 'aac', label: 'AAC (ADTS)', ext: 'aac', kbps: true },
    { id: 'ogg', label: 'OGG · Opus', ext: 'ogg', kbps: true },
    { id: 'vorbis', label: 'OGG · Vorbis', ext: 'ogg', kbps: true },
    { id: 'opus', label: 'OPUS', ext: 'opus', kbps: true },
    { id: 'ac3', label: 'AC3 (Dolby Digital)', ext: 'ac3', kbps: true },
    { id: 'flac', label: 'FLAC (sin pérdida)', ext: 'flac', lossless: true },
    { id: 'alac', label: 'M4A · ALAC (sin pérdida)', ext: 'm4a', lossless: true },
    { id: 'wav', label: 'WAV 16 bit (sin pérdida)', ext: 'wav', lossless: true },
    { id: 'wav24', label: 'WAV 24 bit (sin pérdida)', ext: 'wav', lossless: true },
  ];
  // Contenedor natural para copiar un códec de audio sin recodificar.
  function audioExtForCodec(acodec) {
    if (!acodec) return null;
    if (acodec === 'aac') return 'm4a';
    if (acodec === 'mp3') return 'mp3';
    if (acodec === 'flac') return 'flac';
    if (acodec === 'opus' || acodec === 'vorbis') return 'ogg';
    if (/^pcm_/.test(acodec)) return 'wav';
    return null;
  }
  function audioOutExt(format, acodec) {
    if (format !== 'original') return (AUDIO_FORMATS.find((f) => f.id === format) || AUDIO_FORMATS[1]).ext;
    return audioExtForCodec(acodec) || 'mp3';
  }

  function audioClipDuration(a) {
    return a.out - a.in;
  }

  // margin: fracción del presupuesto que se usa (VP9/AV1 tienden a pasarse más del objetivo).
  function splitBitrate(targetBytes, duration, audioKbps, margin = 0.965) {
    const totalKbps = (targetBytes * 8) / 1000 / Math.max(duration, 0.1);
    let a = audioKbps;
    while (a > 32 && a > totalKbps * 0.15) a = a > 128 ? 128 : a > 96 ? 96 : a > 64 ? 64 : a > 48 ? 48 : 32;
    const v = Math.floor(totalKbps * margin - a);
    return { totalKbps, videoKbps: v, audioKbps: a };
  }

  function qualityLabel(effBpp) {
    if (effBpp >= 0.1) return { label: 'Excelente', level: 5 };
    if (effBpp >= 0.065) return { label: 'Muy buena', level: 4 };
    if (effBpp >= 0.04) return { label: 'Buena', level: 3 };
    if (effBpp >= 0.025) return { label: 'Aceptable', level: 2 };
    return { label: 'Baja', level: 1 };
  }

  function crfLabel(codec, crf) {
    const c = CODECS[codec] || CODECS.h264;
    const rel = (crf - c.crf.min) / (c.crf.max - c.crf.min); // 0 = mejor
    if (rel <= 0.3) return 'Sin pérdidas visibles';
    if (rel <= 0.42) return 'Muy alta';
    if (rel <= 0.52) return 'Alta';
    if (rel <= 0.62) return 'Media';
    if (rel <= 0.75) return 'Baja';
    return 'Muy baja';
  }

  // Plan completo de salida: dimensiones finales, fps, bitrates y estimaciones.
  // clips: [{ srcW, srcH, srcFps, srcFpsStr, srcDuration, srcSize, in, out, speed, rotate, crop, ... }]
  function planOutput(clips, settings) {
    const s = normalizeSettings(settings);
    const codec = CODECS[s.codec] || CODECS.h264;
    const duration = sequenceLayout(clips).total;
    let { width, height } = outputDimensions(s, clips);
    const fpsStr = outputFps(s, clips);
    const fps = parseFps(fpsStr);
    const sourceBytes = clips.reduce((t, c) => t + (c.srcSize || 0) * ((c.out - c.in) / Math.max(c.srcDuration || 0, 0.001)), 0);
    const audioOn = s.audio !== false;
    const plan = {
      duration, width, height, fpsStr, fps, sourceBytes,
      codec: s.codec, container: s.container,
      rateMode: codec.fixedQuality ? 'fixed' : s.rateMode,
      audioKbps: audioOn ? s.audioKbps : 0,
      videoKbps: null, targetBytes: null, estimatedBytes: null,
      quality: null, scaled: false, warnings: [], error: null,
    };
    if (!clips.length) { plan.error = 'La línea de tiempo está vacía.'; return plan; }
    if (s.audioOnly) {
      const af = AUDIO_FORMATS.find((x) => x.id === s.aformat) || AUDIO_FORMATS[1];
      const kbps = af.kbps ? Number(s.audioKbps) : af.id === 'wav24' ? 2304 : af.id === 'wav' ? 1536 : 900;
      Object.assign(plan, { rateMode: 'audio', audioKbps: kbps, estimatedBytes: (kbps * 1000 / 8) * duration });
      return plan;
    }
    if (s.codec === 'gif') {
      plan.audioKbps = 0;
      plan.estimatedBytes = width * height * Math.min(fps, 30) * duration * 0.06;
      if (fps > 30) plan.warnings.push('Un GIF a más de 30 fps pesa muchísimo: prueba con 15–24 fps.');
      if (Math.max(width, height) > 960) plan.warnings.push('Un GIF grande pesa mucho: prueba con 720p o menos.');
      return plan;
    }

    if (plan.rateMode === 'size' || plan.rateMode === 'percent') {
      const target = plan.rateMode === 'size' ? Number(s.targetMB) * MB : (sourceBytes * Number(s.percent)) / 100;
      plan.targetBytes = target;
      // Los codificadores por GPU van en una sola pasada y son menos precisos.
      const hwMargin = s.hw && s.hw !== 'none' && (s.codec === 'h264' || s.codec === 'h265') ? 0.9 : 1;
      const br = splitBitrate(target, duration, plan.audioKbps, (codec.margin || 0.965) * hwMargin);
      plan.videoKbps = br.videoKbps;
      plan.audioKbps = br.audioKbps;
      plan.estimatedBytes = target;
      const effOf = (w, h) => ((plan.videoKbps * 1000) / (w * h * fps)) * codec.efficiency;
      if (s.autoDownscale && plan.videoKbps > 0 && effOf(width, height) < 0.04) {
        const aspect = width / height, short0 = Math.min(width, height);
        for (const sh of [1440, 1080, 720, 540, 480, 360, 240]) {
          if (sh >= short0) continue;
          ({ width, height } = dimsForShortSide(sh, aspect));
          plan.scaled = true;
          if (effOf(width, height) >= 0.05) break;
        }
        plan.width = width;
        plan.height = height;
      }
    } else if (plan.rateMode === 'bitrate') {
      plan.videoKbps = Number(s.bitrateKbps);
      plan.estimatedBytes = (((plan.videoKbps + plan.audioKbps) * 1000) / 8) * duration * 1.01;
    } else if (plan.rateMode === 'fixed') {
      // ProRes 422 HQ ronda los 220 Mb/s a 1080p29.97.
      const kbps = 220000 * ((width * height * fps) / (1920 * 1080 * 29.97));
      plan.estimatedBytes = (((kbps + (audioOn ? 1536 : 0)) * 1000) / 8) * duration;
    }

    if (plan.videoKbps != null) {
      plan.bpp = (plan.videoKbps * 1000) / (width * height * fps);
      plan.quality = qualityLabel(plan.bpp * codec.efficiency);
      if (plan.videoKbps < 30) plan.error = 'El tamaño objetivo es demasiado pequeño para la duración del vídeo.';
      else if (plan.quality.level <= 1)
        plan.warnings.push('El bitrate resultante es muy bajo: la imagen puede verse pixelada. Reduce la resolución o aumenta el tamaño.');
    }
    if (s.fpsMode === 'mci') plan.warnings.push('La interpolación de movimiento es lenta: la exportación tardará bastante más.');
    return plan;
  }

  // ---------------------------------------------------------------------------
  // Utilidades de tiempo y tamaño
  // ---------------------------------------------------------------------------
  const pad = (n, l = 2) => String(Math.floor(n)).padStart(l, '0');

  function formatTimecode(sec, fps = 30) {
    sec = Math.max(0, sec || 0);
    const f = Math.round(parseFps(fps)) || 30;
    let total = Math.round(sec * f);
    const ff = total % f; total = Math.floor(total / f);
    return `${pad(total / 3600)}:${pad((total / 60) % 60)}:${pad(total % 60)}:${pad(ff)}`;
  }

  function formatTime(sec, decimals = 2) {
    sec = Math.max(0, sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec / 60) % 60);
    const s = (sec % 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
    return h ? `${h}:${pad(m)}:${s}` : `${m}:${s}`;
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec / 60) % 60), s = sec % 60;
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min ${s} s`;
    return `${s} s`;
  }

  function parseTime(str, fps = 30) {
    str = String(str || '').trim().replace(',', '.');
    if (!str) return null;
    const parts = str.split(':');
    if (parts.some((p) => p === '' || isNaN(Number(p)))) return null;
    const n = parts.map(Number);
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[0] * 60 + n[1];
    if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
    if (n.length === 4) return n[0] * 3600 + n[1] * 60 + n[2] + n[3] / (Math.round(parseFps(fps)) || 30);
    return null;
  }

  function formatBytes(b) {
    if (!b && b !== 0) return '—';
    if (b < 1024) return `${b} B`;
    if (b < MB) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 * MB) return `${(b / MB).toFixed(b < 10 * MB ? 2 : 1)} MB`;
    return `${(b / 1024 / MB).toFixed(2)} GB`;
  }

  function formatBitrate(kbps) {
    if (kbps == null) return '—';
    return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps >= 10000 ? 0 : 1)} Mb/s` : `${Math.round(kbps)} kb/s`;
  }

  function fpsLabel(v) {
    const n = parseFps(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '');
  }

  function defaultClipProps() {
    return {
      speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
      rotate: 0, flipH: false, flipV: false, crop: null, color: defaultColor(), transOut: null,
    };
  }

  return {
    MB, COLOR_PRESETS, FORMATS, FORMAT_MAP, CODECS, RESOLUTIONS, FPS_OPTIONS, ASPECTS, PRESETS,
    AUDIO_CODECS, defaultAudioCodec, audioCodecFor, SAMPLE_RATES, CHANNELS,
    defaultColor, isDefaultColor, resolveColor, ffmpegColorFilters, svgFilterSpec, svgFilterMarkup,
    defaultSettings, normalizeSettings, defaultClipProps,
    AUDIO_FORMATS, audioExtForCodec, audioOutExt, TRANSITIONS, TRANSITION_MAP, transitionDur, sequenceLayout, TEXT_FONTS, defaultText, audioClipDuration,
    even, parseFps, effectiveSize, canvasAspect, outputDimensions, outputFps, clipDuration,
    splitBitrate, qualityLabel, crfLabel, planOutput, num,
    formatTimecode, formatTime, formatDuration, parseTime, formatBytes, formatBitrate, fpsLabel,
  };
});
