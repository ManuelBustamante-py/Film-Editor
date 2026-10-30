/* Audio Studio: slowed + reverb, nightcore, lo-fi, 8D… con Web Audio.
   La exportación usa el mismo grafo en un OfflineAudioContext, así que lo que
   se escucha es exactamente lo que se guarda. */
(function () {
  const App = window.App;
  const S = (App.studio = {});

  const NEUTRAL = { speed: 1, reverbMix: 0, decay: 2.5, predelay: 20, damping: 9000, bass: 0, treble: 0, lowpass: 20000, pan8d: 0, width: 100, gain: 0, fadeIn: 0, fadeOut: 0 };
  const PRESETS = [
    { id: 'slowed', label: 'Slowed + Reverb', p: { speed: 0.8, reverbMix: 35, decay: 3.2, predelay: 25, damping: 7000, bass: 4, treble: -2, fadeOut: 3 } },
    { id: 'super', label: 'Super slowed', p: { speed: 0.68, reverbMix: 48, decay: 5.5, predelay: 40, damping: 5200, bass: 6, treble: -4, fadeOut: 4 } },
    { id: 'reverb', label: 'Solo reverb', p: { speed: 1, reverbMix: 40, decay: 3.8, predelay: 30, damping: 8000, bass: 2, fadeOut: 3 } },
    { id: 'nightcore', label: 'Nightcore', p: { speed: 1.25, reverbMix: 8, decay: 1.2, predelay: 10, damping: 12000, bass: 2, treble: 2 } },
    { id: 'sped', label: 'Sped up', p: { speed: 1.15, reverbMix: 10, decay: 1.5, bass: 1, treble: 1 } },
    { id: 'lofi', label: 'Lo-fi', p: { speed: 0.92, reverbMix: 22, decay: 2, damping: 5000, lowpass: 3800, bass: 5, treble: -6, width: 85 } },
    { id: '8d', label: 'Audio 8D', p: { speed: 1, reverbMix: 28, decay: 2.6, pan8d: 0.12, bass: 2 } },
    { id: 'underwater', label: 'Bajo el agua', p: { speed: 0.85, reverbMix: 45, decay: 4, lowpass: 900, bass: 8, treble: -10 } },
    { id: 'original', label: 'Original', p: {} },
  ];
  // Todos los formatos de audio comunes, más el vídeo con portada.
  const FORMATS = [
    ...Core.AUDIO_FORMATS.filter((f) => f.id !== 'original'),
    { id: 'mp4', label: 'Vídeo MP4 con portada y onda', ext: 'mp4', kbps: true },
  ];

  const st = {
    buffer: null, path: null, name: '', title: '', info: null, peaks: null, peaksW: 0,
    p: { ...NEUTRAL, ...PRESETS[0].p }, preset: 'slowed',
    trim: { start: 0, end: 0 }, pos: 0, playing: false, loop: false,
    ctx: null, chain: null, analyser: null, src: null, startedAt: 0, startPos: 0,
    format: 'mp3', kbps: 320, sampleRate: 'original', channels: 'original', cover: null, loading: false,
  };
  let root, waveCanvas, vizCanvas, timeEl, playBtn, sliders = {};
  let irKey = '';

  // ------------------------------------------------------------------ DSP
  const db = (v) => Math.pow(10, v / 20);
  const semitones = (speed) => 12 * Math.log2(speed);

  // Respuesta al impulso sintética (ruido estéreo con caída exponencial) con semilla fija.
  function makeIR(ctx, decay) {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * decay));
    const ir = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      let seed = 1234567 + ch * 7919;
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const n = seed / 4294967296 * 2 - 1;
        const t = i / sr;
        d[i] = n * Math.exp((-6.9 * t) / decay) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
      }
    }
    return ir;
  }

  // Grafo de efectos compartido por la vista previa y la exportación.
  function buildChain(ctx, p) {
    const n = {};
    n.input = ctx.createGain();
    n.dry = ctx.createGain();
    n.wet = ctx.createGain();
    n.pre = ctx.createDelay(1);
    n.conv = ctx.createConvolver();
    n.conv.buffer = makeIR(ctx, p.decay);
    n.damp = ctx.createBiquadFilter(); n.damp.type = 'lowpass';
    n.sum = ctx.createGain();
    n.bass = ctx.createBiquadFilter(); n.bass.type = 'lowshelf'; n.bass.frequency.value = 120;
    n.treble = ctx.createBiquadFilter(); n.treble.type = 'highshelf'; n.treble.frequency.value = 6000;
    n.lp = ctx.createBiquadFilter(); n.lp.type = 'lowpass'; n.lp.Q.value = 0.6;
    // Fuerza estéreo antes del divisor (los archivos mono se duplican a ambos canales).
    n.lp.channelCount = 2; n.lp.channelCountMode = 'explicit'; n.lp.channelInterpretation = 'speakers';
    // Anchura estéreo (mid/side): ancho < 100 estrecha, > 100 ensancha.
    n.split = ctx.createChannelSplitter(2);
    n.merge = ctx.createChannelMerger(2);
    n.ll = ctx.createGain(); n.lr = ctx.createGain(); n.rl = ctx.createGain(); n.rr = ctx.createGain();
    n.pan = ctx.createStereoPanner();
    n.lfo = ctx.createOscillator();
    n.lfoGain = ctx.createGain();
    n.out = ctx.createGain();
    n.lim = ctx.createDynamicsCompressor();
    n.lim.threshold.value = -1.5; n.lim.knee.value = 0; n.lim.ratio.value = 20; n.lim.attack.value = 0.002; n.lim.release.value = 0.2;

    n.input.connect(n.dry).connect(n.sum);
    n.input.connect(n.pre).connect(n.conv).connect(n.damp).connect(n.wet).connect(n.sum);
    n.sum.connect(n.bass).connect(n.treble).connect(n.lp).connect(n.split);
    n.split.connect(n.ll, 0); n.split.connect(n.lr, 0); n.split.connect(n.rl, 1); n.split.connect(n.rr, 1);
    n.ll.connect(n.merge, 0, 0); n.rl.connect(n.merge, 0, 0); n.lr.connect(n.merge, 0, 1); n.rr.connect(n.merge, 0, 1);
    n.merge.connect(n.pan).connect(n.out).connect(n.lim);
    n.lfo.connect(n.lfoGain).connect(n.pan.pan);
    n.lfo.start(0);
    n.set = (q, at = ctx.currentTime) => {
      const m = q.reverbMix / 100;
      const sp = (param, v) => param.setTargetAtTime(v, at, 0.02);
      sp(n.dry.gain, 1 - 0.55 * m);
      sp(n.wet.gain, 1.15 * m);
      n.pre.delayTime.setValueAtTime(q.predelay / 1000, at);
      sp(n.damp.frequency, q.damping);
      sp(n.bass.gain, q.bass);
      sp(n.treble.gain, q.treble);
      sp(n.lp.frequency, q.lowpass);
      const w = q.width / 100;
      const a = (1 + w) / 2, b = (1 - w) / 2;
      sp(n.ll.gain, a); sp(n.rr.gain, a); sp(n.lr.gain, b); sp(n.rl.gain, b);
      n.lfo.frequency.setValueAtTime(Math.max(0.001, q.pan8d), at);
      sp(n.lfoGain.gain, q.pan8d > 0 ? 0.85 : 0);
      sp(n.out.gain, db(q.gain));
    };
    // En un contexto offline los valores se fijan sin rampas.
    if (ctx instanceof OfflineAudioContext) {
      n.set = (q) => {
        const m = q.reverbMix / 100;
        n.dry.gain.value = 1 - 0.55 * m;
        n.wet.gain.value = 1.15 * m;
        n.pre.delayTime.value = q.predelay / 1000;
        n.damp.frequency.value = q.damping;
        n.bass.gain.value = q.bass;
        n.treble.gain.value = q.treble;
        n.lp.frequency.value = q.lowpass;
        const w = q.width / 100;
        n.ll.gain.value = n.rr.gain.value = (1 + w) / 2;
        n.lr.gain.value = n.rl.gain.value = (1 - w) / 2;
        n.lfo.frequency.value = Math.max(0.001, q.pan8d);
        n.lfoGain.gain.value = q.pan8d > 0 ? 0.85 : 0;
        n.out.gain.value = db(q.gain);
      };
    }
    n.set(p);
    return n;
  }

  function ensureCtx() {
    if (st.ctx) { if (st.ctx.state === 'suspended') st.ctx.resume(); return st.ctx; }
    st.ctx = new AudioContext({ latencyHint: 'playback' });
    return st.ctx;
  }

  function ensureChain() {
    const ctx = ensureCtx();
    if (!st.chain) {
      st.chain = buildChain(ctx, st.p);
      st.analyser = ctx.createAnalyser();
      st.analyser.fftSize = 2048;
      st.analyser.smoothingTimeConstant = 0.78;
      st.chain.lim.connect(st.analyser).connect(ctx.destination);
      irKey = String(st.p.decay);
    }
    return st.chain;
  }

  function applyParams() {
    if (!st.chain) return;
    st.chain.set(st.p);
    if (String(st.p.decay) !== irKey) {
      irKey = String(st.p.decay);
      clearTimeout(applyParams.t);
      applyParams.t = setTimeout(() => { st.chain.conv.buffer = makeIR(st.ctx, st.p.decay); }, 120);
    }
    if (st.src) {
      st.startPos = position();
      st.startedAt = st.ctx.currentTime;
      st.src.playbackRate.setValueAtTime(st.p.speed, st.ctx.currentTime);
    }
  }

  // ------------------------------------------------------------------ transporte
  function position() {
    if (!st.playing || !st.ctx) return st.pos;
    return st.startPos + (st.ctx.currentTime - st.startedAt) * st.p.speed;
  }

  function play() {
    if (!st.buffer) return;
    const chain = ensureChain();
    stopSource();
    let pos = st.pos;
    if (pos < st.trim.start || pos >= st.trim.end - 0.02) pos = st.trim.start;
    const src = st.ctx.createBufferSource();
    src.buffer = st.buffer;
    src.playbackRate.value = st.p.speed;
    src.connect(chain.input);
    src.start(0, pos);
    st.src = src;
    st.startPos = pos;
    st.startedAt = st.ctx.currentTime;
    st.playing = true;
    updatePlayBtn();
  }

  function stopSource() {
    if (st.src) {
      try { st.src.stop(); } catch { /* ya parado */ }
      st.src.disconnect();
      st.src = null;
    }
  }

  function pause() {
    st.pos = position();
    st.playing = false;
    stopSource();
    updatePlayBtn();
  }

  function seek(pos) {
    const was = st.playing;
    if (was) stopSource();
    st.pos = clamp(pos, 0, st.buffer ? st.buffer.duration : 0);
    st.playing = false;
    if (was) play();
    drawWave();
    updateTime();
  }

  S.toggle = () => (st.playing ? pause() : play());

  function updatePlayBtn() {
    if (playBtn) playBtn.innerHTML = icon(st.playing ? 'pause' : 'play');
  }

  function finalDuration() {
    return (st.trim.end - st.trim.start) / st.p.speed;
  }

  function updateTime() {
    if (!timeEl) return;
    const out = Math.max(0, (position() - st.trim.start) / st.p.speed);
    timeEl.innerHTML = `${Core.formatTime(out, 1)}<small>/ ${Core.formatTime(finalDuration(), 1)}</small>`;
  }

  // ------------------------------------------------------------------ dibujo
  function computePeaks(width) {
    const b = st.buffer;
    const chs = Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i));
    const step = b.length / width;
    const peaks = new Float32Array(width * 2);
    for (let x = 0; x < width; x++) {
      let min = 1, max = -1;
      const s0 = Math.floor(x * step), s1 = Math.min(b.length, Math.floor((x + 1) * step));
      const inc = Math.max(1, Math.floor((s1 - s0) / 400));
      for (let i = s0; i < s1; i += inc) {
        for (const d of chs) { const v = d[i]; if (v < min) min = v; if (v > max) max = v; }
      }
      peaks[x * 2] = min;
      peaks[x * 2 + 1] = max;
    }
    st.peaks = peaks;
    st.peaksW = width;
  }

  function drawWave() {
    if (!waveCanvas || !st.buffer) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(waveCanvas.clientWidth * dpr), H = Math.round(waveCanvas.clientHeight * dpr);
    if (!W || !H) return;
    if (waveCanvas.width !== W || waveCanvas.height !== H) { waveCanvas.width = W; waveCanvas.height = H; }
    if (st.peaksW !== W) computePeaks(W);
    const ctx = waveCanvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const dur = st.buffer.duration;
    const xs = (st.trim.start / dur) * W, xe = (st.trim.end / dur) * W, xp = (position() / dur) * W;
    const mid = H / 2;
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#a99dff');
    grad.addColorStop(1, '#2dd4bf');
    for (let x = 0; x < W; x++) {
      const min = st.peaks[x * 2], max = st.peaks[x * 2 + 1];
      const inside = x >= xs && x <= xe;
      ctx.fillStyle = !inside ? 'rgba(255,255,255,.13)' : x <= xp ? grad : 'rgba(169,157,255,.55)';
      const y1 = mid - max * mid * 0.92, y2 = mid - min * mid * 0.92;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(0, 0, xs, H);
    ctx.fillRect(xe, 0, W - xe, H);
    for (const x of [xs, xe]) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1 * dpr, 0, 2 * dpr, H);
      ctx.beginPath();
      ctx.roundRect(x - 6 * dpr, mid - 16 * dpr, 12 * dpr, 32 * dpr, 4 * dpr);
      ctx.fill();
    }
    ctx.fillStyle = '#ff5d73';
    ctx.fillRect(xp - 1 * dpr, 0, 2 * dpr, H);
  }

  const vizState = new Float32Array(72);
  function drawViz() {
    if (!vizCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(vizCanvas.clientWidth * dpr), H = Math.round(vizCanvas.clientHeight * dpr);
    if (!W || !H) return;
    if (vizCanvas.width !== W || vizCanvas.height !== H) { vizCanvas.width = W; vizCanvas.height = H; }
    const ctx = vizCanvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const n = vizState.length;
    let data = null;
    if (st.analyser && st.playing) {
      data = new Uint8Array(st.analyser.frequencyBinCount);
      st.analyser.getByteFrequencyData(data);
    }
    const gap = 3 * dpr, bw = (W - gap * (n - 1)) / n;
    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, 'rgba(139,123,255,.95)');
    grad.addColorStop(1, 'rgba(45,212,191,.95)');
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (data) {
        // Distribución logarítmica de frecuencias.
        const a = Math.floor(Math.pow(i / n, 2) * data.length * 0.7), b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / n, 2) * data.length * 0.7));
        let sum = 0;
        for (let k = a; k < b; k++) sum += data[k];
        v = sum / (b - a) / 255;
      }
      vizState[i] = Math.max(v, vizState[i] * 0.9);
      const bh = Math.max(2 * dpr, vizState[i] * H * 0.92);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(i * (bw + gap), H - bh, bw, bh, Math.min(bw / 2, 4 * dpr));
      ctx.fill();
    }
  }

  function loop() {
    if (st.buffer && root && root.offsetParent) {
      if (st.playing) {
        const pos = position();
        // Fundidos aplicados en la vista previa (en tiempo de salida).
        const out = (pos - st.trim.start) / st.p.speed, len = finalDuration();
        let g = 1;
        if (st.p.fadeIn > 0) g = Math.min(g, out / st.p.fadeIn);
        if (st.p.fadeOut > 0) g = Math.min(g, (len - out) / st.p.fadeOut);
        st.chain.input.gain.setTargetAtTime(clamp(g, 0, 1), st.ctx.currentTime, 0.02);
        if (pos >= st.trim.end) {
          if (st.loop) { st.pos = st.trim.start; stopSource(); st.playing = false; play(); }
          else { pause(); st.pos = st.trim.start; }
        }
      }
      drawWave();
      drawViz();
      updateTime();
    }
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ carga
  async function decode(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo leer el archivo (${res.status})`);
    return ensureCtx().decodeAudioData(await res.arrayBuffer());
  }

  S.load = async function (path) {
    if (st.playing) pause();
    st.loading = true;
    render();
    try {
      const info = await window.api.probe(path);
      if (!info.hasAudio) throw new Error('El archivo no tiene pista de audio.');
      let buffer;
      try { buffer = await decode(info.url); } catch { buffer = await decode(await window.api.audioExtract(path)); }
      st.buffer = buffer;
      st.path = path;
      st.info = info;
      st.name = baseName(path);
      st.title = info.title || stripExt(st.name);
      st.trim = { start: 0, end: buffer.duration };
      st.pos = 0;
      st.peaksW = 0;
    } catch (e) {
      toast(`No se pudo abrir el audio: ${cleanIpcError(e.message)}`, 'err', 6000);
    }
    st.loading = false;
    render();
  };

  async function pick() {
    const paths = await window.api.openMedia('audio');
    if (paths[0]) S.load(paths[0]);
  }

  // ------------------------------------------------------------------ render offline
  async function renderOffline() {
    const b = st.buffer, p = { ...st.p };
    const sr = b.sampleRate;
    const len = (st.trim.end - st.trim.start) / p.speed;
    const tail = p.reverbMix > 0 ? p.decay + p.predelay / 1000 : 0.05;
    const off = new OfflineAudioContext(2, Math.ceil((len + tail) * sr), sr);
    const chain = buildChain(off, p);
    chain.lim.connect(off.destination);
    const src = off.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = p.speed;
    src.connect(chain.input);
    const g = chain.input.gain;
    g.setValueAtTime(p.fadeIn > 0 ? 0 : 1, 0);
    if (p.fadeIn > 0) g.linearRampToValueAtTime(1, Math.min(p.fadeIn, len));
    if (p.fadeOut > 0) {
      g.setValueAtTime(1, Math.max(p.fadeIn, len - p.fadeOut));
      g.linearRampToValueAtTime(0, len);
    }
    src.start(0, st.trim.start);
    src.stop(len);
    const out = await off.startRendering();
    return { out, len: len + tail };
  }

  function encodeWav(buf) {
    const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
    const data = new ArrayBuffer(44 + n * ch * 2);
    const v = new DataView(data);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * ch * 2, true);
    const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Uint8Array(data);
  }

  function suffix() {
    const p = PRESETS.find((x) => x.id === st.preset);
    if (!p || p.id === 'original') return 'editado';
    return p.label.toLowerCase();
  }

  async function exportAudio(presetPath) {
    if (!st.buffer) return;
    if (st.playing) pause();
    const f = FORMATS.find((x) => x.id === st.format);
    const dir = st.path ? dirName(st.path) : (await window.api.paths()).music;
    const out = typeof presetPath === 'string' ? presetPath : await window.api.saveExportPath({ defaultName: `${dir}\\${st.title} (${suffix()}).${f.ext}`, ext: f.ext });
    if (!out) return;
    if (st.path && out.toLowerCase().replace(/\//g, '\\') === st.path.toLowerCase().replace(/\//g, '\\')) return toast('No puedes sobrescribir el archivo original', 'err');
    const host = h('div');
    const m = modal({ title: 'Exportar audio', body: host });
    m.setLocked(true);
    const pv = App.progressView({ title: 'Renderizando efectos…' });
    host.appendChild(pv.el);
    try {
      const { out: rendered, len } = await renderOffline();
      const wav = encodeWav(rendered);
      const id = uid('aud');
      host.innerHTML = '';
      const pv2 = App.progressView({ title: 'Codificando…', onCancel: () => window.api.cancelJob(id) });
      host.appendChild(pv2.el);
      const off = window.api.onJobProgress((d) => { if (d.id === id) pv2.update(d); });
      const res = await window.api.audioEncode({ id, wav, outputPath: out, format: f.id, kbps: st.kbps, sampleRate: st.sampleRate, channels: st.channels, title: `${st.title} (${suffix()})`, cover: st.cover, duration: len });
      off();
      m.setLocked(false);
      host.innerHTML = '';
      host.appendChild(App.resultView(res, { onClose: () => m.close() }));
      if (res.ok) toast(`Exportado: ${baseName(res.path)}`, 'ok', 4000);
      return res;
    } catch (e) {
      m.setLocked(false);
      host.innerHTML = '';
      host.appendChild(App.resultView({ ok: false, error: e.message }, { onClose: () => m.close() }));
    }
  }

  async function sendToEditor() {
    if (!st.buffer) return;
    if (st.playing) pause();
    toast('Renderizando audio para el editor…', 'info', 2500);
    try {
      const { out } = await renderOffline();
      const file = await window.api.saveWav(encodeWav(out), `${st.title} (${suffix()})`);
      App.showView('editor');
      await App.library.importPaths([file], { toTimeline: true, start: App.state.playhead });
      toast('Audio añadido a la línea de tiempo del editor', 'ok', 3000);
    } catch (e) {
      toast(`No se pudo enviar al editor: ${cleanIpcError(e.message)}`, 'err', 6000);
    }
  }

  // ------------------------------------------------------------------ interfaz
  function slider(key, label, min, max, step, fmt, extra) {
    const input = h('input', { type: 'range', min, max, step, value: st.p[key] });
    const val = h('span', { class: `val${st.p[key] !== NEUTRAL[key] ? ' changed' : ''}`, title: 'Doble clic para restablecer' }, fmt(st.p[key]));
    const set = (v) => {
      st.p[key] = v;
      val.textContent = fmt(v);
      val.classList.toggle('changed', v !== NEUTRAL[key]);
      paintRange(input);
      st.preset = null;
      $$('.st-preset', root).forEach((b) => b.classList.remove('on'));
      if (extra) extra(v);
      applyParams();
    };
    input.addEventListener('input', () => set(Number(input.value)));
    const reset = () => { input.value = NEUTRAL[key]; set(NEUTRAL[key]); };
    val.addEventListener('dblclick', reset);
    input.addEventListener('dblclick', reset);
    paintRange(input);
    sliders[key] = { input, set: (v) => { input.value = v; set(v); } };
    return h('div', { class: 'slider' }, h('span', { class: 'lbl' }, label), val, input);
  }

  function sect(title, ic, ...children) {
    return h('div', { class: 'section' },
      h('div', { class: 'section-head', html: icon(ic) }, h('span', null, title)),
      h('div', { class: 'section-body' }, ...children));
  }

  function applyPreset(p) {
    st.preset = p.id;
    st.p = { ...NEUTRAL, ...p.p };
    applyParams();
    render();
  }

  function render() {
    if (!root) return;
    root.innerHTML = '';
    sliders = {};
    if (!st.buffer || st.loading) {
      const main = h('div', { class: 'st-main' });
      if (st.loading) main.appendChild(h('div', { class: 'st-loading glass st-card' }, h('div', { class: 'spinner' }), 'Cargando y analizando el audio…'));
      else {
        const dz = h('div', { class: 'st-drop glass', html: icon('wave'), onclick: pick },
          h('h3', null, 'Audio Studio'),
          h('div', null, 'Crea versiones slowed + reverb, nightcore, lo-fi u 8D de cualquier canción.'),
          h('div', { class: 'small' }, 'Arrastra un MP3, WAV, FLAC, M4A… o un vídeo, o haz clic para elegir.'));
        wireDrop(dz);
        main.appendChild(dz);
      }
      root.appendChild(main);
      root.appendChild(h('aside', { class: 'st-side glass' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Efectos')),
        h('div', { class: 'insp-empty', html: icon('sliders') }, 'Carga un audio para empezar.')));
      return;
    }

    const i = st.info;
    // ---- columna principal
    const cover = h('div', { class: 'st-cover', html: st.cover ? '' : icon('music') });
    if (st.cover) cover.style.backgroundImage = `url("${encodeURI(`file:///${st.cover.replace(/\\/g, '/')}`)}")`;
    const titleIn = h('input', { type: 'text', value: st.title, style: { fontSize: '17px', fontWeight: 650, height: '34px', width: '100%', fontFamily: 'var(--font)' }, title: 'Título (se usa en el nombre y en los metadatos)' });
    titleIn.addEventListener('input', () => { st.title = titleIn.value || stripExt(st.name); });
    const headCard = h('div', { class: 'st-card glass st-head' }, cover,
      h('div', { style: { flex: 1, minWidth: 0 } }, titleIn,
        h('div', { class: 'st-sub' },
          h('span', { class: 'badge' }, Core.formatTime(st.buffer.duration, 1)),
          h('span', { class: 'badge' }, `${st.buffer.sampleRate} Hz`),
          h('span', { class: 'badge' }, (i.acodec || '').toUpperCase()),
          i.artist ? h('span', { class: 'badge teal' }, i.artist) : null,
          h('span', { class: 'badge' }, st.name))),
      h('button', { class: 'btn small', html: icon('folder'), onclick: pick }, 'Abrir otro'));
    wireDrop(headCard);

    waveCanvas = h('canvas');
    vizCanvas = h('canvas');
    playBtn = h('button', { class: 'tbtn play', onclick: S.toggle, title: 'Reproducir / pausa (Espacio)' });
    timeEl = h('span', { class: 'st-time' });
    const loopBtn = h('button', { class: `btn small ghost icon-only${st.loop ? ' active' : ''}`, html: icon('loop'), title: 'Repetir',
      onclick: () => { st.loop = !st.loop; loopBtn.classList.toggle('active', st.loop); } });
    const waveCard = h('div', { class: 'st-card glass st-wave-card' },
      h('div', { class: 'st-presets' }, PRESETS.map((p) => h('button', { class: `st-preset${st.preset === p.id ? ' on' : ''}`, onclick: () => applyPreset(p) }, p.label))),
      h('div', { class: 'st-wave-wrap' }, waveCanvas),
      h('div', { class: 'st-transport' },
        h('button', { class: 'tbtn', html: icon('skipStart'), title: 'Al inicio del recorte', onclick: () => seek(st.trim.start) }),
        playBtn,
        h('button', { class: 'tbtn', html: icon('stop'), title: 'Detener', onclick: () => { pause(); seek(st.trim.start); } }),
        loopBtn, timeEl,
        h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, 'Arrastra los marcadores blancos para recortar · clic para saltar')),
      h('div', { class: 'st-viz-wrap' }, vizCanvas));
    root.appendChild(h('div', { class: 'st-main' }, headCard, waveCard));
    updatePlayBtn();
    wireWave();

    // ---- columna de efectos
    const pct = (v) => `${Math.round(v)}%`;
    const dbf = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    const semi = h('span', { class: 'semi' });
    const updSemi = (v) => { const s = semitones(v); semi.textContent = `${s > 0 ? '+' : ''}${s.toFixed(1)} semitonos · duración ${Core.formatTime(finalDuration(), 1)}`; };
    updSemi(st.p.speed);
    const side = h('aside', { class: 'st-side glass' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Efectos'), h('button', { class: 'btn small ghost', html: icon('reset'), onclick: () => applyPreset(PRESETS[8]) }, 'Neutro')),
      h('div', { class: 'panel-body' },
        sect('Velocidad y tono', 'speed',
          slider('speed', 'Velocidad', 0.5, 1.5, 0.01, (v) => `${v.toFixed(2)}×`, updSemi), semi,
          h('div', { class: 'hint' }, 'Como un vinilo: más lento = tono más grave (efecto slowed); más rápido = nightcore.')),
        sect('Reverb', 'wave',
          slider('reverbMix', 'Cantidad (mezcla)', 0, 100, 1, pct),
          slider('decay', 'Tamaño de la sala', 0.5, 10, 0.1, (v) => `${v.toFixed(1)} s`),
          slider('predelay', 'Pre-retardo', 0, 200, 1, (v) => `${v} ms`),
          slider('damping', 'Brillo de la reverb', 1000, 16000, 100, (v) => `${(v / 1000).toFixed(1)} kHz`)),
        sect('Ecualizador', 'sliders',
          slider('bass', 'Graves', -6, 15, 0.5, dbf),
          slider('treble', 'Agudos', -15, 8, 0.5, dbf),
          slider('lowpass', 'Filtro lo-fi / apagado', 400, 20000, 100, (v) => (v >= 20000 ? 'Off' : `${(v / 1000).toFixed(1)} kHz`))),
        sect('Espacio', 'headphones',
          slider('pan8d', 'Audio 8D (giro)', 0, 0.5, 0.01, (v) => (v ? `${v.toFixed(2)} Hz` : 'Off')),
          slider('width', 'Anchura estéreo', 0, 200, 1, pct),
          h('div', { class: 'hint' }, 'El efecto 8D se aprecia mejor con auriculares.')),
        sect('Salida', 'volume',
          slider('gain', 'Ganancia', -12, 12, 0.5, dbf),
          slider('fadeIn', 'Fundido de entrada', 0, 10, 0.1, (v) => `${v.toFixed(1)} s`),
          slider('fadeOut', 'Fundido de salida', 0, 15, 0.1, (v) => `${v.toFixed(1)} s`),
          h('div', { class: 'hint' }, 'Un limitador evita que el sonido sature.'))),
      exportPanel());
    root.appendChild(side);
    requestAnimationFrame(drawWave);
  }

  function exportPanel() {
    const f = FORMATS.find((x) => x.id === st.format);
    const fmt = h('select', null, FORMATS.map((x) => h('option', { value: x.id }, x.label)));
    fmt.value = st.format;
    fmt.addEventListener('change', () => { st.format = fmt.value; render(); });
    const kb = h('select', null, [96, 128, 160, 192, 256, 320].map((v) => h('option', { value: String(v) }, `${v} kb/s`)));
    kb.value = String(st.kbps);
    kb.addEventListener('change', () => { st.kbps = Number(kb.value); });
    const sr = h('select', { title: 'Frecuencia de muestreo' }, Core.SAMPLE_RATES.map((x) => h('option', { value: x.id }, x.id === 'original' ? 'Frecuencia original' : x.label)));
    sr.value = st.sampleRate;
    sr.addEventListener('change', () => { st.sampleRate = sr.value; });
    const chs = h('select', { title: 'Canales' }, Core.CHANNELS.map((x) => h('option', { value: x.id }, x.id === 'original' ? 'Canales originales' : x.label)));
    chs.value = st.channels;
    chs.addEventListener('change', () => { st.channels = chs.value; });
    return h('div', { class: 'st-export' },
      h('div', { class: 'row' }, fmt, f.kbps ? kb : null),
      h('div', { class: 'row' }, sr, chs),
      st.format === 'mp4' ? h('div', { class: 'row' },
        h('button', { class: 'btn small', html: icon('image'), onclick: async () => { const p = await window.api.openMedia('image'); if (p[0]) { st.cover = p[0]; render(); } } }, st.cover ? 'Cambiar portada' : 'Elegir portada'),
        st.cover ? h('button', { class: 'btn small ghost', onclick: () => { st.cover = null; render(); } }, 'Quitar') : h('span', { class: 'hint' }, 'Sin portada: fondo con onda animada')) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn teal', html: icon('send'), title: 'Renderiza y lo coloca en una pista de audio del editor', onclick: sendToEditor }, 'Al editor'),
        h('button', { class: 'btn primary', html: icon('export'), onclick: exportAudio }, 'Exportar')));
  }

  function wireWave() {
    waveCanvas.addEventListener('pointerdown', (e) => {
      if (!st.buffer) return;
      waveCanvas.setPointerCapture(e.pointerId);
      const r = waveCanvas.getBoundingClientRect();
      const dur = st.buffer.duration;
      const tAt = (ev) => clamp(((ev.clientX - r.left) / r.width) * dur, 0, dur);
      const px = (t) => (t / dur) * r.width + r.left;
      let mode = 'seek';
      if (Math.abs(e.clientX - px(st.trim.start)) < 9) mode = 'start';
      else if (Math.abs(e.clientX - px(st.trim.end)) < 9) mode = 'end';
      const go = (ev) => {
        const t = tAt(ev);
        if (mode === 'start') st.trim.start = Math.min(t, st.trim.end - 0.5);
        else if (mode === 'end') st.trim.end = Math.max(t, st.trim.start + 0.5);
        else seek(t);
        if (mode !== 'seek' && sliders.speed) {
          const s = semitones(st.p.speed);
          const semi = $('.semi', root);
          if (semi) semi.textContent = `${s > 0 ? '+' : ''}${s.toFixed(1)} semitonos · duración ${Core.formatTime(finalDuration(), 1)}`;
        }
      };
      go(e);
      const up = () => { waveCanvas.removeEventListener('pointermove', go); waveCanvas.removeEventListener('pointerup', up); };
      waveCanvas.addEventListener('pointermove', go);
      waveCanvas.addEventListener('pointerup', up);
    });
    waveCanvas.addEventListener('mousemove', (e) => {
      if (!st.buffer) return;
      const r = waveCanvas.getBoundingClientRect();
      const px = (t) => (t / st.buffer.duration) * r.width + r.left;
      waveCanvas.style.cursor = Math.abs(e.clientX - px(st.trim.start)) < 9 || Math.abs(e.clientX - px(st.trim.end)) < 9 ? 'ew-resize' : 'pointer';
    });
  }

  function wireDrop(el) {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('drag-over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) S.load(window.api.pathForFile(f));
    });
  }

  S.exportTo = exportAudio;
  S.onHide = () => { if (st.playing) pause(); };
  S.isActive = () => !!(root && root.offsetParent);
  S.init = function () {
    root = $('#studio');
    render();
    new ResizeObserver(() => { st.peaksW = 0; drawWave(); }).observe(root);
    requestAnimationFrame(loop);
  };
  S._state = st;
})();
