/* Cortador de audio: recortar, eliminar fragmentos y dividir en partes.
   La edición se procesa con FFmpeg (copia sin recodificar cuando es posible). */
(function () {
  const App = window.App;
  const X = (App.cutter = {});
  const BIN = 256; // muestras por bloque de la caché de picos

  const cs = {
    path: null, info: null, buffer: null, title: '', loading: false,
    pmin: null, pmax: null,
    view: { a: 0, b: 0 }, sel: { a: 0, b: 0 }, cursor: 0, markers: [],
    mode: 'keep', fadeIn: 0, fadeOut: 0, gainDb: 0, normalize: false,
    format: 'original', kbps: 256, sampleRate: 'original', channels: 'original',
    playing: false, loop: false, ctx: null, src: null, startedAt: 0, startPos: 0, playEnd: 0,
  };
  let root, wave, overview, timeEl, playBtn, selInputs = {};

  const dur = () => (cs.buffer ? cs.buffer.duration : 0);
  const hasSel = () => cs.sel.b - cs.sel.a > 0.01;

  // ------------------------------------------------------------------ carga
  function ensureCtx() {
    if (!cs.ctx) cs.ctx = new AudioContext({ latencyHint: 'playback' });
    if (cs.ctx.state === 'suspended') cs.ctx.resume();
    return cs.ctx;
  }

  async function decode(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo leer el archivo (${res.status})`);
    return ensureCtx().decodeAudioData(await res.arrayBuffer());
  }

  function buildPeaks() {
    const b = cs.buffer;
    const chs = Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i));
    const n = Math.ceil(b.length / BIN);
    cs.pmin = new Float32Array(n);
    cs.pmax = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let mn = 1, mx = -1;
      const s1 = Math.min(b.length, (k + 1) * BIN);
      for (let i = k * BIN; i < s1; i += 2) {
        for (const d of chs) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      }
      cs.pmin[k] = mn;
      cs.pmax[k] = mx;
    }
  }

  X.load = async function (path) {
    stop();
    cs.loading = true;
    render();
    try {
      const info = await window.api.probe(path);
      if (!info.hasAudio) throw new Error('El archivo no tiene pista de audio.');
      let buffer;
      try { buffer = await decode(info.url); } catch { buffer = await decode(await window.api.audioExtract(path)); }
      Object.assign(cs, {
        path, info, buffer, title: info.title || stripExt(baseName(path)),
        view: { a: 0, b: buffer.duration }, sel: { a: 0, b: 0 }, cursor: 0, markers: [],
      });
      buildPeaks();
    } catch (e) {
      toast(`No se pudo abrir el audio: ${cleanIpcError(e.message)}`, 'err', 6000);
    }
    cs.loading = false;
    render();
  };

  async function pick() {
    const p = await window.api.openMedia('audio');
    if (p[0]) X.load(p[0]);
  }

  // ------------------------------------------------------------------ reproducción
  function position() {
    if (!cs.playing) return cs.cursor;
    return cs.startPos + (cs.ctx.currentTime - cs.startedAt);
  }

  function play(from, to) {
    if (!cs.buffer) return;
    ensureCtx();
    stopSource();
    from = clamp(from, 0, dur());
    cs.playEnd = to == null ? dur() : Math.min(to, dur());
    if (from >= cs.playEnd - 0.02) from = 0;
    const src = cs.ctx.createBufferSource();
    src.buffer = cs.buffer;
    src.connect(cs.ctx.destination);
    src.start(0, from);
    cs.src = src;
    cs.startPos = from;
    cs.startedAt = cs.ctx.currentTime;
    cs.playing = true;
    updatePlayBtn();
  }

  function stopSource() {
    if (cs.src) { try { cs.src.stop(); } catch { /* ya parado */ } cs.src.disconnect(); cs.src = null; }
  }

  function stop() {
    if (cs.playing) cs.cursor = clamp(position(), 0, dur());
    cs.playing = false;
    stopSource();
    updatePlayBtn();
  }

  // Espacio: reproduce desde el cursor (dentro de la selección se detiene en su final).
  X.toggle = function () {
    if (cs.playing) return stop();
    const inSel = hasSel() && cs.cursor >= cs.sel.a && cs.cursor < cs.sel.b && cs.mode === 'keep';
    play(cs.cursor, inSel ? cs.sel.b : null);
  };
  function playSelection() {
    if (!hasSel()) return toast('Primero selecciona un fragmento arrastrando sobre la onda', 'warn');
    play(cs.sel.a, cs.sel.b);
  }

  function updatePlayBtn() {
    if (playBtn) playBtn.innerHTML = icon(cs.playing ? 'pause' : 'play');
  }

  function tick() {
    if (cs.buffer && root && root.offsetParent) {
      if (cs.playing) {
        const pos = position();
        if (cs.mode === 'remove' && hasSel() && pos >= cs.sel.a && pos < cs.sel.b - 0.01) play(cs.sel.b, cs.playEnd);
        else if (pos >= cs.playEnd) {
          if (cs.loop && hasSel()) play(cs.sel.a, cs.sel.b);
          else { stop(); cs.cursor = cs.playEnd >= dur() - 0.01 ? 0 : cs.playEnd; }
        }
        // El cursor se mantiene a la vista durante la reproducción.
        const p = position(), span = cs.view.b - cs.view.a;
        if (p > cs.view.b || p < cs.view.a) setView(p - span * 0.05, p + span * 0.95);
      }
      draw();
      updateTime();
    }
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ vista
  function setView(a, b) {
    const D = dur();
    let span = clamp(b - a, Math.min(0.05, D), D);
    a = clamp(a, 0, D - span);
    cs.view = { a, b: a + span };
  }
  function zoom(f, at) {
    const { a, b } = cs.view;
    const c = at ?? (a + b) / 2;
    setView(c - (c - a) * f, c + (b - c) * f);
  }

  // ------------------------------------------------------------------ dibujo
  const RULER = 22;
  function sizeCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    return { W, H, dpr };
  }

  function peakRange(t0, t1) {
    const b = cs.buffer, sr = b.sampleRate;
    const s0 = Math.max(0, Math.floor(t0 * sr)), s1 = Math.min(b.length, Math.ceil(t1 * sr));
    let mn = 1, mx = -1;
    if (s1 - s0 >= BIN * 2) {
      for (let k = Math.floor(s0 / BIN), e = Math.ceil(s1 / BIN); k < e; k++) {
        if (cs.pmin[k] < mn) mn = cs.pmin[k];
        if (cs.pmax[k] > mx) mx = cs.pmax[k];
      }
    } else {
      const d = b.getChannelData(0);
      for (let i = s0; i < Math.max(s1, s0 + 1); i++) { const v = d[i] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    return mn > mx ? [0, 0] : [mn, mx];
  }

  function draw() {
    if (!wave || !cs.buffer) return;
    const { W, H, dpr } = sizeCanvas(wave);
    if (!W || !H) return;
    const ctx = wave.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const { a, b } = cs.view, span = b - a;
    const X0 = (t) => ((t - a) / span) * W;
    const rh = RULER * dpr, mid = rh + (H - rh) / 2, amp = (H - rh) / 2 * 0.9;

    // Regla
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.fillRect(0, 0, W, rh);
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => (s / span) * W >= 90 * dpr) || 600;
    ctx.font = `${10.5 * dpr}px "Cascadia Mono", Consolas, monospace`;
    ctx.textBaseline = 'top';
    for (let t = Math.ceil(a / major) * major; t <= b; t += major) {
      const x = Math.round(X0(t)) + 0.5;
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fillRect(x, rh - 8 * dpr, 1, 8 * dpr);
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(x, rh, 1, H - rh);
      ctx.fillStyle = '#8b93a3';
      ctx.fillText(Core.formatTime(t, major < 1 ? 2 : 0), x + 4 * dpr, 4 * dpr);
    }

    // Selección
    const sa = X0(cs.sel.a), sb = X0(cs.sel.b), sel = hasSel();
    const remove = cs.mode === 'remove';
    if (sel) {
      ctx.fillStyle = remove ? 'rgba(248,113,113,.16)' : 'rgba(139,123,255,.2)';
      ctx.fillRect(sa, rh, sb - sa, H - rh);
    }
    // Onda
    const grad = ctx.createLinearGradient(0, rh, 0, H);
    grad.addColorStop(0, '#a99dff');
    grad.addColorStop(0.5, '#7dd3fc');
    grad.addColorStop(1, '#2dd4bf');
    for (let x = 0; x < W; x++) {
      const t0 = a + (x / W) * span, t1 = a + ((x + 1) / W) * span;
      const [mn, mx] = peakRange(t0, t1);
      const inside = sel && x >= sa && x <= sb;
      const dim = sel && (remove ? inside : !inside);
      ctx.fillStyle = dim ? 'rgba(255,255,255,.16)' : grad;
      const y1 = mid - mx * amp, y2 = mid - mn * amp;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    // Bordes de la selección
    if (sel) {
      for (const x of [sa, sb]) {
        ctx.fillStyle = remove ? '#fca5a5' : '#fff';
        ctx.fillRect(x - dpr, rh, 2 * dpr, H - rh);
        ctx.beginPath();
        ctx.roundRect(x - 6 * dpr, rh, 12 * dpr, 16 * dpr, 3 * dpr);
        ctx.fill();
      }
    }
    // Marcadores
    cs.markers.forEach((m, i) => {
      const x = X0(m);
      if (x < -10 || x > W + 10) return;
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(x - dpr / 2, rh, dpr, H - rh);
      ctx.beginPath();
      ctx.moveTo(x, rh); ctx.lineTo(x + 18 * dpr, rh); ctx.lineTo(x + 18 * dpr, rh + 14 * dpr); ctx.lineTo(x, rh + 14 * dpr);
      ctx.fill();
      ctx.fillStyle = '#1a1300';
      ctx.font = `700 ${9.5 * dpr}px "Segoe UI", sans-serif`;
      ctx.fillText(String(i + 1), x + 4 * dpr, rh + 2 * dpr);
    });
    // Cursor
    const xp = X0(position());
    ctx.fillStyle = '#ff5d73';
    ctx.fillRect(xp - dpr, 0, 2 * dpr, H);
    ctx.beginPath();
    ctx.moveTo(xp - 6 * dpr, 0); ctx.lineTo(xp + 6 * dpr, 0); ctx.lineTo(xp, 9 * dpr);
    ctx.fill();

    drawOverview();
  }

  function drawOverview() {
    if (!overview) return;
    const { W, H, dpr } = sizeCanvas(overview);
    if (!W || !H) return;
    const ctx = overview.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const D = dur(), mid = H / 2;
    ctx.fillStyle = 'rgba(169,157,255,.55)';
    for (let x = 0; x < W; x++) {
      const [mn, mx] = peakRange((x / W) * D, ((x + 1) / W) * D);
      ctx.fillRect(x, mid - mx * mid * 0.85, 1, Math.max(1, (mx - mn) * mid * 0.85));
    }
    if (hasSel()) {
      ctx.fillStyle = cs.mode === 'remove' ? 'rgba(248,113,113,.3)' : 'rgba(139,123,255,.3)';
      ctx.fillRect((cs.sel.a / D) * W, 0, ((cs.sel.b - cs.sel.a) / D) * W, H);
    }
    const va = (cs.view.a / D) * W, vb = (cs.view.b / D) * W;
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(0, 0, va, H);
    ctx.fillRect(vb, 0, W - vb, H);
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeRect(va + dpr, dpr, Math.max(4 * dpr, vb - va - 2 * dpr), H - 2 * dpr);
    ctx.fillStyle = '#ff5d73';
    ctx.fillRect((position() / D) * W - dpr / 2, 0, dpr, H);
  }

  function resultDuration() {
    if (!hasSel()) return dur();
    return cs.mode === 'keep' ? cs.sel.b - cs.sel.a : dur() - (cs.sel.b - cs.sel.a);
  }

  function updateTime() {
    if (!timeEl) return;
    timeEl.innerHTML = `${Core.formatTime(position(), 2)}<small>/ ${Core.formatTime(dur(), 2)}</small>`;
    const r = $('#cut-result', root);
    if (r) r.textContent = Core.formatTime(resultDuration(), 2);
  }

  function syncSelInputs() {
    if (!selInputs.a) return;
    const on = hasSel();
    selInputs.a.value = on ? Core.formatTime(cs.sel.a, 3) : '';
    selInputs.b.value = on ? Core.formatTime(cs.sel.b, 3) : '';
    selInputs.d.value = on ? Core.formatTime(cs.sel.b - cs.sel.a, 3) : '';
  }

  // ------------------------------------------------------------------ interacción con la onda
  function wireWave() {
    const tAt = (ev) => {
      const r = wave.getBoundingClientRect();
      return clamp(cs.view.a + ((ev.clientX - r.left) / r.width) * (cs.view.b - cs.view.a), 0, dur());
    };
    const pxOf = (t) => {
      const r = wave.getBoundingClientRect();
      return r.left + ((t - cs.view.a) / (cs.view.b - cs.view.a)) * r.width;
    };
    wave.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      wave.setPointerCapture(e.pointerId);
      const t0 = tAt(e);
      let mode = 'new', mi = -1;
      if (hasSel() && Math.abs(e.clientX - pxOf(cs.sel.a)) < 8) mode = 'a';
      else if (hasSel() && Math.abs(e.clientX - pxOf(cs.sel.b)) < 8) mode = 'b';
      else {
        mi = cs.markers.findIndex((m) => Math.abs(e.clientX - pxOf(m)) < 6);
        if (mi >= 0) mode = 'marker';
      }
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - e.clientX) < 3) return;
        moved = true;
        const t = tAt(ev);
        if (mode === 'a') cs.sel.a = Math.min(t, cs.sel.b - 0.01);
        else if (mode === 'b') cs.sel.b = Math.max(t, cs.sel.a + 0.01);
        else if (mode === 'marker') { cs.markers[mi] = t; }
        else cs.sel = { a: Math.min(t0, t), b: Math.max(t0, t) };
        syncSelInputs();
      };
      const up = () => {
        wave.removeEventListener('pointermove', move);
        wave.removeEventListener('pointerup', up);
        if (mode === 'marker') cs.markers.sort((x, y) => x - y);
        if (!moved && mode === 'new') {
          cs.cursor = t0;
          if (cs.playing) play(t0, null);
        }
        renderSide();
      };
      wave.addEventListener('pointermove', move);
      wave.addEventListener('pointerup', up);
    });
    wave.addEventListener('mousemove', (e) => {
      if (!cs.buffer) return;
      const near = (t) => Math.abs(e.clientX - pxOf(t)) < 8;
      wave.style.cursor = hasSel() && (near(cs.sel.a) || near(cs.sel.b)) ? 'ew-resize' : cs.markers.some(near) ? 'col-resize' : 'crosshair';
    });
    wave.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        const span = cs.view.b - cs.view.a;
        setView(cs.view.a + (e.deltaY / 600) * span, cs.view.b + (e.deltaY / 600) * span);
      } else zoom(e.deltaY < 0 ? 0.8 : 1.25, tAt(e));
    }, { passive: false });
    wave.addEventListener('dblclick', () => selectAll());

    overview.addEventListener('pointerdown', (e) => {
      overview.setPointerCapture(e.pointerId);
      const go = (ev) => {
        const r = overview.getBoundingClientRect();
        const t = clamp(((ev.clientX - r.left) / r.width) * dur(), 0, dur());
        const span = cs.view.b - cs.view.a;
        setView(t - span / 2, t + span / 2);
      };
      go(e);
      const up = () => { overview.removeEventListener('pointermove', go); overview.removeEventListener('pointerup', up); };
      overview.addEventListener('pointermove', go);
      overview.addEventListener('pointerup', up);
    });
  }

  // ------------------------------------------------------------------ acciones
  function selectAll() { cs.sel = { a: 0, b: dur() }; syncSelInputs(); renderSide(); }
  function clearSel() { cs.sel = { a: 0, b: 0 }; syncSelInputs(); renderSide(); }
  function quickSel(len) {
    const a = clamp(cs.cursor, 0, Math.max(0, dur() - len));
    cs.sel = { a, b: Math.min(dur(), a + len) };
    syncSelInputs();
    renderSide();
  }
  X.addMarker = function () {
    if (!cs.buffer) return;
    const t = position();
    if (t < 0.05 || t > dur() - 0.05 || cs.markers.some((m) => Math.abs(m - t) < 0.05)) return toast('Ya hay un marcador aquí', 'warn', 1500);
    cs.markers.push(t);
    cs.markers.sort((x, y) => x - y);
    renderSide();
  };
  X.markSel = function (which) {
    const t = position();
    if (!hasSel()) cs.sel = which === 'a' ? { a: t, b: dur() } : { a: 0, b: t };
    else if (which === 'a') cs.sel.a = Math.min(t, cs.sel.b - 0.01);
    else cs.sel.b = Math.max(t, cs.sel.a + 0.01);
    syncSelInputs();
    renderSide();
  };

  function segments() {
    if (!hasSel()) return [{ start: 0, end: dur() }];
    if (cs.mode === 'keep') return [{ start: cs.sel.a, end: cs.sel.b }];
    return [{ start: 0, end: cs.sel.a }, { start: cs.sel.b, end: dur() }].filter((s) => s.end - s.start > 0.01);
  }

  function jobBase() {
    return { input: cs.path, acodec: cs.info.acodec, fadeIn: cs.fadeIn, fadeOut: cs.fadeOut, gainDb: cs.gainDb, normalize: cs.normalize, format: cs.format, kbps: cs.kbps, sampleRate: cs.sampleRate, channels: cs.channels };
  }

  function isCopy(segs) {
    return cs.format === 'original' && segs.length === 1 && !cs.fadeIn && !cs.fadeOut && !cs.gainDb && !cs.normalize
      && cs.sampleRate === 'original' && cs.channels === 'original'
      && Core.audioExtForCodec(cs.info.acodec) === Core.audioOutExt('original', cs.info.acodec);
  }

  // Ejecuta una lista de trabajos de corte mostrando el progreso en un modal.
  async function runJobs(list, { onDone } = {}) {
    const host = h('div');
    const m = modal({ title: list.length > 1 ? `Exportar ${list.length} partes` : 'Exportar audio', body: host });
    m.setLocked(true);
    let last = null;
    for (let i = 0; i < list.length; i++) {
      const id = uid('cut');
      const pv = App.progressView({ title: list.length > 1 ? `Parte ${i + 1} de ${list.length}` : 'Cortando audio…', onCancel: () => window.api.cancelJob(id) });
      host.innerHTML = '';
      host.appendChild(pv.el);
      const off = window.api.onJobProgress((d) => { if (d.id === id) pv.update(d); });
      last = await window.api.audioCut({ id, ...list[i] });
      off();
      if (!last.ok) break;
    }
    m.setLocked(false);
    host.innerHTML = '';
    if (last.ok && list.length > 1) last.encoder = `${list.length} archivos · ${last.encoder}`;
    host.appendChild(App.resultView(last, { onClose: () => m.close() }));
    if (last.ok) { toast('Audio exportado', 'ok', 2500); onDone && onDone(last); }
    return last;
  }

  async function exportCut(presetPath) {
    if (!cs.buffer) return;
    stop();
    const segs = segments();
    const ext = Core.audioOutExt(cs.format, cs.info.acodec);
    const suffix = !hasSel() ? 'editado' : cs.mode === 'keep' ? 'recorte' : 'sin fragmento';
    const out = typeof presetPath === 'string' ? presetPath
      : await window.api.saveExportPath({ defaultName: `${dirName(cs.path)}\\${cs.title} (${suffix}).${ext}`, ext });
    if (!out) return;
    if (out.toLowerCase().replace(/\//g, '\\') === cs.path.toLowerCase().replace(/\//g, '\\')) return toast('No puedes sobrescribir el archivo original', 'err');
    return runJobs([{ ...jobBase(), segments: segs, outputPath: out }]);
  }

  async function exportParts() {
    if (!cs.buffer || !cs.markers.length) return;
    stop();
    const ext = Core.audioOutExt(cs.format, cs.info.acodec);
    const first = await window.api.saveExportPath({ defaultName: `${dirName(cs.path)}\\${cs.title} - parte 1.${ext}`, ext });
    if (!first) return;
    const dir = dirName(first);
    const base = stripExt(baseName(first)).replace(/ - parte \d+$/i, '');
    const cuts = [0, ...cs.markers, dur()];
    const list = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      list.push({ ...jobBase(), segments: [{ start: cuts[i], end: cuts[i + 1] }], outputPath: `${dir}\\${base} - parte ${i + 1}.${ext}` });
    }
    return runJobs(list);
  }

  async function sendToEditor() {
    if (!cs.buffer) return;
    stop();
    const ext = Core.audioOutExt(cs.format, cs.info.acodec);
    const dir = `${(await window.api.paths()).music}\\Fotograma Studio`;
    let out = `${dir}\\${cs.title} (recorte).${ext}`;
    for (let n = 2; (await window.api.stat(out)).exists; n++) out = `${dir}\\${cs.title} (recorte ${n}).${ext}`;
    const id = uid('cut');
    toast('Preparando el audio para el editor…', 'info', 2000);
    const r = await window.api.audioCut({ id, ...jobBase(), segments: segments(), outputPath: out });
    if (!r.ok) return toast(`No se pudo cortar: ${r.error}`, 'err', 6000);
    App.showView('editor');
    await App.library.importPaths([r.path], { toTimeline: true, start: App.state.playhead });
  }

  // ------------------------------------------------------------------ interfaz
  function timeInput(key) {
    const inp = h('input', { type: 'text', placeholder: '—' });
    inp.addEventListener('change', () => {
      const t = Core.parseTime(inp.value);
      if (t == null) return syncSelInputs();
      const D = dur();
      if (key === 'a') cs.sel = { a: clamp(t, 0, D), b: Math.max(cs.sel.b, clamp(t, 0, D) + 0.01) };
      else if (key === 'b') cs.sel = { a: Math.min(cs.sel.a, clamp(t, 0, D) - 0.01), b: clamp(t, 0, D) };
      else cs.sel = { a: cs.sel.a, b: clamp(cs.sel.a + t, cs.sel.a + 0.01, D) };
      cs.sel.a = Math.max(0, cs.sel.a);
      syncSelInputs();
      renderSide();
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    selInputs[key] = inp;
    return inp;
  }

  function slider(label, min, max, step, key, fmt) {
    const input = h('input', { type: 'range', min, max, step, value: cs[key] });
    const val = h('span', { class: `val${cs[key] ? ' changed' : ''}` }, fmt(cs[key]));
    input.addEventListener('input', () => {
      cs[key] = Number(input.value);
      val.textContent = fmt(cs[key]);
      val.classList.toggle('changed', !!cs[key]);
      updateCopyHint();
    });
    input.addEventListener('dblclick', () => { input.value = 0; input.dispatchEvent(new Event('input')); paintRange(input); });
    paintRange(input);
    return h('div', { class: 'slider' }, h('span', { class: 'lbl' }, label), val, input);
  }

  function updateCopyHint() {
    const el = $('#cut-copy', root);
    if (!el) return;
    const copy = isCopy(segments());
    el.className = `warnbox ${copy ? 'info' : 'neutral'}`;
    el.innerHTML = `${icon(copy ? 'sparkle' : 'info')}<span>${copy
      ? 'Se copiará el audio <b>sin recodificar</b>: instantáneo y sin pérdida de calidad.'
      : cs.format === 'original' ? 'Se recodificará con el mismo formato (fundidos, ajustes o varios fragmentos).' : `Se recodificará a ${cs.format.toUpperCase()}.`}</span>`;
  }

  function sect(title, ic, ...children) {
    return h('div', { class: 'section' },
      h('div', { class: 'section-head', html: icon(ic) }, h('span', null, title)),
      h('div', { class: 'section-body' }, ...children));
  }

  let sideEl = null;
  function renderSide() {
    if (!sideEl || !cs.buffer) return;
    const body = $('.panel-body', sideEl);
    const scroll = body.scrollTop;
    body.innerHTML = '';
    const fmt = h('select', null, Core.AUDIO_FORMATS.map((f) => h('option', { value: f.id }, f.label)));
    fmt.value = cs.format;
    fmt.addEventListener('change', () => { cs.format = fmt.value; renderSide(); });
    const fdef = Core.AUDIO_FORMATS.find((f) => f.id === cs.format);
    const kb = h('select', null, [96, 128, 192, 256, 320].map((v) => h('option', { value: String(v) }, `${v} kb/s`)));
    kb.value = String(cs.kbps);
    kb.addEventListener('change', () => { cs.kbps = Number(kb.value); });
    const norm = h('input', { type: 'checkbox', class: 'switch', checked: cs.normalize });
    norm.addEventListener('change', () => { cs.normalize = norm.checked; updateCopyHint(); });

    body.appendChild(sect('Qué hacer con la selección', 'scissors',
      h('div', { class: 'seg block' },
        h('button', { class: cs.mode === 'keep' ? 'on' : '', onclick: () => { cs.mode = 'keep'; renderSide(); } }, 'Conservar'),
        h('button', { class: cs.mode === 'remove' ? 'on' : '', onclick: () => { cs.mode = 'remove'; renderSide(); } }, 'Eliminar')),
      h('div', { class: 'hint' }, !hasSel()
        ? 'Sin selección se exporta el archivo completo. Arrastra sobre la onda para seleccionar.'
        : cs.mode === 'keep' ? 'Se guarda solo el fragmento seleccionado.' : 'Se quita el fragmento seleccionado y se une el resto.'),
      h('dl', { class: 'kv' }, h('dt', null, 'Duración del resultado'), h('dd', { id: 'cut-result' }, Core.formatTime(resultDuration(), 2)))));

    body.appendChild(sect('Ajustes', 'sliders',
      slider('Fundido de entrada', 0, 10, 0.1, 'fadeIn', (v) => `${v.toFixed(1)} s`),
      slider('Fundido de salida', 0, 10, 0.1, 'fadeOut', (v) => `${v.toFixed(1)} s`),
      slider('Ganancia', -12, 12, 0.5, 'gainDb', (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`),
      h('label', { class: 'check-row' }, norm, 'Normalizar volumen (−14 LUFS, como Spotify/YouTube)')));

    body.appendChild(sect(`Marcadores (${cs.markers.length})`, 'layers',
      h('div', { class: 'hint' }, 'Coloca marcadores (tecla M) para dividir el audio en varias partes y exportarlas por separado.'),
      cs.markers.length ? h('div', { class: 'marker-list' }, cs.markers.map((m, i) => h('div', { class: 'marker-row' },
        h('span', { class: 'mk-num' }, String(i + 1)),
        h('span', { class: 'mk-time', onclick: () => { cs.cursor = m; const s = cs.view.b - cs.view.a; if (m < cs.view.a || m > cs.view.b) setView(m - s / 2, m + s / 2); } }, Core.formatTime(m, 3)),
        h('button', { class: 'th-btn', html: icon('x'), title: 'Quitar', onclick: () => { cs.markers.splice(i, 1); renderSide(); } })))) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', html: icon('plus'), onclick: X.addMarker }, 'En el cursor'),
        h('button', { class: 'btn small ghost', disabled: !cs.markers.length, onclick: () => { cs.markers = []; renderSide(); } }, 'Quitar todos'))));

    const sr = h('select', { title: 'Frecuencia de muestreo' }, Core.SAMPLE_RATES.map((x) => h('option', { value: x.id }, x.id === 'original' ? 'Frecuencia original' : x.label)));
    sr.value = cs.sampleRate;
    sr.addEventListener('change', () => { cs.sampleRate = sr.value; updateCopyHint(); });
    const chs = h('select', { title: 'Canales' }, Core.CHANNELS.map((x) => h('option', { value: x.id }, x.id === 'original' ? 'Canales originales' : x.label)));
    chs.value = cs.channels;
    chs.addEventListener('change', () => { cs.channels = chs.value; updateCopyHint(); });
    body.appendChild(sect('Formato de salida', 'export',
      h('div', { class: 'row' }, fmt, fdef.kbps ? kb : null),
      h('div', { class: 'row' }, sr, chs),
      h('div', { id: 'cut-copy' })));
    updateCopyHint();
    body.scrollTop = scroll;
    const parts = $('#cut-parts', sideEl);
    if (parts) {
      parts.disabled = !cs.markers.length;
      parts.innerHTML = `${icon('layers')}Exportar ${cs.markers.length ? cs.markers.length + 1 : ''} partes`;
    }
  }

  function render() {
    if (!root) return;
    root.innerHTML = '';
    selInputs = {};
    if (!cs.buffer || cs.loading) {
      const main = h('div', { class: 'st-main' });
      if (cs.loading) main.appendChild(h('div', { class: 'st-loading glass st-card' }, h('div', { class: 'spinner' }), 'Cargando y analizando el audio…'));
      else {
        const dz = h('div', { class: 'st-drop glass', html: icon('scissors'), onclick: pick },
          h('h3', null, 'Cortador de audio'),
          h('div', null, 'Recorta canciones, quita fragmentos o divide un audio en varias partes.'),
          h('div', { class: 'small' }, 'Arrastra un MP3, WAV, FLAC, M4A, OGG… o un vídeo, o haz clic para elegir.'));
        wireDrop(dz);
        main.appendChild(dz);
      }
      root.appendChild(main);
      root.appendChild(h('aside', { class: 'st-side glass' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Edición')),
        h('div', { class: 'insp-empty', html: icon('scissors') }, 'Carga un audio para empezar.')));
      wave = overview = null;
      return;
    }
    const i = cs.info;
    const titleIn = h('input', { type: 'text', value: cs.title, class: 'title-input', title: 'Nombre base de los archivos exportados' });
    titleIn.addEventListener('input', () => { cs.title = titleIn.value || stripExt(baseName(cs.path)); });
    const head = h('div', { class: 'st-card glass st-head' },
      h('div', { class: 'st-cover', html: icon('scissors') }),
      h('div', { style: { flex: 1, minWidth: 0 } }, titleIn,
        h('div', { class: 'st-sub' },
          h('span', { class: 'badge' }, Core.formatTime(dur(), 2)),
          h('span', { class: 'badge' }, (i.acodec || '').toUpperCase()),
          h('span', { class: 'badge' }, `${cs.buffer.sampleRate} Hz`),
          i.bitrate ? h('span', { class: 'badge' }, Core.formatBitrate(i.bitrate / 1000)) : null,
          h('span', { class: 'badge' }, Core.formatBytes(i.size)),
          i.artist ? h('span', { class: 'badge teal' }, i.artist) : null)),
      h('button', { class: 'btn small', html: icon('wave'), title: 'Abrir este audio en Audio Studio', onclick: () => { App.showView('studio'); App.studio.load(cs.path); } }, 'Audio Studio'),
      h('button', { class: 'btn small', html: icon('folder'), onclick: pick }, 'Abrir otro'));
    wireDrop(head);

    wave = h('canvas', { class: 'cut-wave' });
    overview = h('canvas', { class: 'cut-overview' });
    playBtn = h('button', { class: 'tbtn play', onclick: X.toggle, title: 'Reproducir / pausa (Espacio)' });
    timeEl = h('span', { class: 'st-time' });
    const loopBtn = h('button', { class: `btn small ghost icon-only${cs.loop ? ' active' : ''}`, html: icon('loop'), title: 'Repetir la selección',
      onclick: () => { cs.loop = !cs.loop; loopBtn.classList.toggle('active', cs.loop); } });
    const card = h('div', { class: 'st-card glass st-wave-card' },
      h('div', { class: 'cut-toolbar' },
        h('label', { class: 'field' }, h('span', null, 'Inicio'), timeInput('a')),
        h('label', { class: 'field' }, h('span', null, 'Fin'), timeInput('b')),
        h('label', { class: 'field' }, h('span', null, 'Duración'), timeInput('d')),
        h('div', { class: 'field' }, h('span', null, 'Selección rápida desde el cursor'),
          h('div', { class: 'chips' },
            [15, 30, 60].map((s) => h('button', { class: 'chip', onclick: () => quickSel(s) }, `${s} s`)),
            h('button', { class: 'chip', onclick: selectAll }, 'Todo'),
            h('button', { class: 'chip', onclick: clearSel }, 'Ninguna'))),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small ghost icon-only', html: icon('zoomOut'), title: 'Alejar', onclick: () => zoom(1.5) }),
        h('button', { class: 'btn small ghost icon-only', html: icon('zoomIn'), title: 'Acercar (rueda del ratón)', onclick: () => zoom(1 / 1.5) }),
        h('button', { class: 'btn small ghost', html: icon('crop'), title: 'Ver solo la selección', onclick: () => { if (hasSel()) { const p = (cs.sel.b - cs.sel.a) * 0.08; setView(cs.sel.a - p, cs.sel.b + p); } } }, 'Selección'),
        h('button', { class: 'btn small ghost', html: icon('fit'), onclick: () => setView(0, dur()) }, 'Todo')),
      h('div', { class: 'st-wave-wrap cut-wrap' }, wave),
      h('div', { class: 'cut-ov-wrap' }, overview),
      h('div', { class: 'st-transport' },
        h('button', { class: 'tbtn', html: icon('skipStart'), title: 'Al inicio (Inicio)', onclick: () => { stop(); cs.cursor = 0; setView(0, cs.view.b - cs.view.a); } }),
        playBtn,
        h('button', { class: 'tbtn', html: icon('stop'), title: 'Detener', onclick: stop }),
        h('button', { class: 'btn small', html: icon('play2'), onclick: playSelection }, 'Escuchar selección'),
        loopBtn,
        timeEl,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small ghost', title: 'Inicio de la selección en el cursor (I)', onclick: () => X.markSel('a') }, '[ Inicio'),
        h('button', { class: 'btn small ghost', title: 'Fin de la selección en el cursor (O)', onclick: () => X.markSel('b') }, 'Fin ]'),
        h('button', { class: 'btn small ghost', html: icon('plus'), title: 'Marcador para dividir (M)', onclick: X.addMarker }, 'Marcador')),
      h('div', { class: 'hint' }, 'Arrastra sobre la onda para seleccionar · arrastra los bordes para ajustar · rueda: zoom · Mayús + rueda: desplazar · doble clic: seleccionar todo'));
    root.appendChild(h('div', { class: 'st-main' }, head, card));

    sideEl = h('aside', { class: 'st-side glass' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Edición')),
      h('div', { class: 'panel-body' }),
      h('div', { class: 'st-export' },
        h('button', { class: 'btn small block', id: 'cut-parts', onclick: exportParts }),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn teal', html: icon('send'), title: 'Coloca el resultado en una pista de audio del editor', onclick: sendToEditor }, 'Al editor'),
          h('button', { class: 'btn primary', html: icon('export'), onclick: exportCut }, 'Exportar'))));
    root.appendChild(sideEl);
    renderSide();
    syncSelInputs();
    updatePlayBtn();
    wireWave();
  }

  function wireDrop(el) {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('drag-over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) X.load(window.api.pathForFile(f));
    });
  }

  // Atajos propios de esta vista.
  X.key = function (e) {
    const k = e.key.toLowerCase();
    if (e.key === ' ') { e.preventDefault(); X.toggle(); }
    else if (k === 'm') X.addMarker();
    else if (k === 'i') X.markSel('a');
    else if (k === 'o') X.markSel('b');
    else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); selectAll(); }
    else if (e.key === 'Escape') clearSel();
    else if (e.key === 'Home') { stop(); cs.cursor = 0; }
    else if (e.key === 'ArrowLeft') { stop(); cs.cursor = Math.max(0, cs.cursor - (e.shiftKey ? 5 : 1)); }
    else if (e.key === 'ArrowRight') { stop(); cs.cursor = Math.min(dur(), cs.cursor + (e.shiftKey ? 5 : 1)); }
  };

  X.exportTo = exportCut;
  X.isActive = () => !!(root && root.offsetParent);
  X.onHide = () => { if (cs.playing) stop(); };
  X.init = function () {
    root = $('#cutter');
    render();
    requestAnimationFrame(tick);
  };
  X._state = cs;
})();
