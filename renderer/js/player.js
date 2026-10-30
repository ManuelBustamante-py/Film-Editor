/* Visor: reproducción multipista con dos capas de vídeo (cambios sin cortes y
   transiciones), mezcla de audio por Web Audio, textos y encuadre. */
(function () {
  const App = window.App;
  const { state } = App;
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const P = (App.player = {
    mode: 'sequence',       // 'sequence' | 'source'
    playing: false,
    sourceMediaId: null,
    srcIn: null, srcOut: null,
    cropEdit: false, cropAspect: null,
    previewVolume: 1, previewMuted: false,
    frameRect: { x: 0, y: 0, w: 1, h: 1 }, frameAspect: 16 / 9, framePx: { w: 1, h: 1 },
  });
  let stage, flashEl, textCanvas, cropLayer, cropBox;
  const layers = [];
  let actx = null, master = null;
  const audioEls = new Map();        // id de clip de audio → { el, gain, src }
  let clock = { wall: 0, head: 0 };
  let stageSize = { w: 1, h: 1 };
  let textDrag = null;

  const now = () => performance.now() / 1000;

  // ------------------------------------------------------------------ secuencia
  P.sequence = function () {
    const lay = Core.sequenceLayout(state.clips);
    lay.items.forEach((it) => { it.clip = state.clips[it.i]; });
    return lay;
  };

  P.locate = function (t) {
    const { items } = P.sequence();
    if (!items.length) return null;
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k];
      if (t >= it.start && t < it.start + it.dur) return { i: it.i, local: t - it.start, item: it };
    }
    const last = items[items.length - 1];
    if (t >= last.start + last.dur) return { i: last.i, local: last.dur, item: last };
    return { i: 0, local: 0, item: items[0] };
  };

  // Clips de vídeo visibles en el instante t (dos durante una transición).
  function activeItems(seq, t) {
    const a = seq.items.filter((it) => t >= it.start - 1e-6 && t < it.start + it.dur - 1e-6);
    // Justo en el final exacto del vídeo se muestra su último fotograma; más allá, negro.
    if (!a.length && seq.items.length && Math.abs(t - seq.total) < 1e-3) a.push(seq.items[seq.items.length - 1]);
    return a.slice(-2);
  }

  P.outFps = function () {
    if (P.mode === 'source') { const m = App.media(P.sourceMediaId); return m && m.info.fps ? m.info.fps : 30; }
    return Core.parseFps(Core.outputFps(Core.normalizeSettings(state.settings), App.jobClips()));
  };

  P.endTime = () => App.contentEnd();

  // ------------------------------------------------------------------ audio
  function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    actx = new AudioContext({ latencyHint: 'playback' });
    master = actx.createGain();
    master.connect(actx.destination);
    applyMaster();
    layers.forEach(connectLayer);
    audioEls.forEach(connectAudio);
  }
  function applyMaster() {
    if (master) master.gain.value = P.previewMuted ? 0 : P.previewVolume;
  }
  function connectLayer(L) {
    if (!actx || L.gain) return;
    L.src = actx.createMediaElementSource(L.video);
    L.gain = actx.createGain();
    L.src.connect(L.gain).connect(master);
    L.video.volume = 1;
  }
  function connectAudio(A) {
    if (!actx || A.gain) return;
    A.src = actx.createMediaElementSource(A.el);
    A.gain = actx.createGain();
    A.src.connect(A.gain).connect(master);
    A.el.volume = 1;
  }
  function setGain(obj, el, v) {
    if (obj.gain) obj.gain.gain.setTargetAtTime(v, actx.currentTime, 0.015);
    else el.volume = clamp(v * P.previewVolume, 0, 1);
  }

  // ------------------------------------------------------------------ proxies
  function showStatus(text) {
    const el = $('#stage-status');
    el.hidden = !text;
    if (text) el.innerHTML = `<div class="spinner"></div><span>${text}</span>`;
  }

  function requestProxy(m) {
    if (m.proxyPromise) return m.proxyPromise;
    const id = `proxy:${m.id}`;
    showStatus(`Preparando vista previa de <b>${m.name}</b>… 0%`);
    const off = window.api.onJobProgress((d) => {
      if (d.id === id) showStatus(`Preparando vista previa de <b>${m.name}</b>… ${Math.round(d.pct * 100)}%`);
    });
    m.proxyPromise = window.api.proxy(m.path, m.info, id).then((url) => {
      m.proxyUrl = url;
      off();
      showStatus(null);
      if (P.mode === 'source' && P.sourceMediaId === m.id) P.setSourceMedia(m.id);
      return url;
    }).catch((e) => {
      off();
      showStatus(null);
      toast(`No se pudo preparar la vista previa: ${cleanIpcError(e.message)}`, 'err', 6000);
      m.proxyPromise = null;
    });
    return m.proxyPromise;
  }

  function srcFor(m) {
    if (m.proxyUrl) return m.proxyUrl;
    if (m.info.needsProxy || m.forceProxy) { requestProxy(m); return null; }
    return m.info.url;
  }

  // ------------------------------------------------------------------ capas
  function makeLayer(root, idx) {
    const L = { root, idx, content: root.querySelector('.content'), video: root.querySelector('video'),
      vignette: root.querySelector('.vignette'), defs: $(`#fx-defs-${idx}`), clipId: null, src: null, ready: false, colorKey: null, fxn: 0 };
    L.video.crossOrigin = 'anonymous';
    L.video.addEventListener('loadedmetadata', () => { L.ready = true; });
    L.video.addEventListener('error', () => {
      const c = App.clip(L.clipId);
      const m = P.mode === 'source' && L.idx === 0 ? App.media(P.sourceMediaId) : c && App.clipMedia(c);
      if (m && !m.proxyUrl && !m.forceProxy && L.video.getAttribute('src')) {
        m.forceProxy = true;
        L.src = null;
        L.clipId = null;
        if (P.mode === 'source') P.setSourceMedia(m.id);
      }
    });
    return L;
  }

  function setSrc(L, src) {
    if (L.src === src) return;
    L.src = src;
    L.ready = false;
    if (src) L.video.src = src;
    else { L.video.removeAttribute('src'); L.video.load(); }
  }

  function loadInto(L, clip) {
    L.clipId = clip.id;
    const m = App.clipMedia(clip);
    const src = srcFor(m);
    setSrc(L, src);
  }

  function applyLook(L, c) {
    const key = JSON.stringify(c.color);
    if (key !== L.colorKey) {
      L.colorKey = key;
      if (Core.isDefaultColor(c.color)) {
        L.video.style.filter = 'none';
        L.defs.innerHTML = '';
      } else {
        const id = `fx${L.idx}_${++L.fxn}`;
        L.defs.innerHTML = Core.svgFilterMarkup(id, c.color);
        L.video.style.filter = `url(#${id})`;
      }
      const v = (c.color.vignette || 0) / 100;
      L.vignette.style.background = v > 0
        ? `radial-gradient(ellipse at center, rgba(0,0,0,0) ${60 - v * 35}%, rgba(0,0,0,${(0.35 + 0.55 * v).toFixed(2)}) 100%)`
        : 'none';
    }
  }

  function box(el, x, y, w, hgt) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${hgt}px`;
  }

  // Coloca el vídeo de la capa según rotación, encuadre y modo de ajuste.
  function layoutLayer(L, c) {
    const { w: sw, h: sh } = stageSize;
    const m = App.clipMedia(c);
    const iw = m.info.width, ih = m.info.height;
    const r = (((c.rotate || 0) % 360) + 360) % 360;
    const rot = r % 180 !== 0;
    const rw = rot ? ih : iw, rh = rot ? iw : ih;
    const editing = P.cropEdit && c.id === state.selectedId;
    const crop = editing ? FULL : c.crop || FULL;
    const ew = rw * crop.w, eh = rh * crop.h;
    const cover = !editing && state.settings.fit === 'cover';
    const k = cover ? Math.max(sw / ew, sh / eh) : Math.min(sw / ew, sh / eh);
    const bw = ew * k, bh = eh * k, bx = (sw - bw) / 2, by = (sh - bh) / 2;
    box(L.content, bx, by, bw, bh);
    const fw = rw * k, fh = rh * k, fx = -crop.x * fw, fy = -crop.y * fh;
    const vw = iw * k, vh = ih * k;
    box(L.video, fx + fw / 2 - vw / 2, fy + fh / 2 - vh / 2, vw, vh);
    L.video.style.transform = `rotate(${r}deg) scale(${c.flipH ? -1 : 1}, ${c.flipV ? -1 : 1})`;
    if (editing) {
      P.frameRect = { x: bx, y: by, w: bw, h: bh };
      P.frameAspect = rw / rh;
      P.framePx = { w: rw, h: rh };
      positionCropBox();
    }
  }

  function hideLayer(L) {
    L.root.style.visibility = 'hidden';
    if (!L.video.paused) L.video.pause();
  }

  function resetLayerStyle(L) {
    L.root.style.visibility = 'visible';
    L.root.style.opacity = '1';
    L.root.style.clipPath = 'none';
    L.root.style.transform = 'none';
  }

  function fadeEnv(c, local, dur) {
    let f = 1;
    if (c.fadeIn > 0) f = Math.min(f, local / c.fadeIn);
    if (c.fadeOut > 0) f = Math.min(f, (dur - local) / c.fadeOut);
    return clamp(f, 0, 1);
  }

  // Sincroniza un elemento multimedia con el tiempo esperado.
  function sync(el, expected, playing, rate) {
    if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
    if (playing) {
      if (el.paused) {
        if (Math.abs(el.currentTime - expected) > 0.04) el.currentTime = expected;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - expected) > 0.3 && !el.seeking) el.currentTime = expected;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - expected) > 0.008 && !el.seeking) el.currentTime = expected;
    }
  }

  // ------------------------------------------------------------------ fotograma
  function renderSequence(t, playing) {
    const seq = P.sequence();
    const act = activeItems(seq, t);
    $('#stage-empty').hidden = seq.items.length > 0 || state.audioClips.length > 0 || state.textClips.length > 0;

    // Precarga del siguiente clip cuando solo hay uno visible.
    let pre = null;
    if (act.length === 1) {
      const nx = seq.items[act[0].i + 1];
      if (nx && nx.start - t < 2.5) pre = nx;
    }
    const want = act.map((it) => it.clip.id);
    if (pre) want.push(pre.clip.id);
    const owner = new Map();
    layers.forEach((L) => { if (want.includes(L.clipId) && !owner.has(L.clipId)) owner.set(L.clipId, L); });
    for (const id of want) {
      if (owner.has(id)) continue;
      const L = layers.find((x) => ![...owner.values()].includes(x));
      if (!L) break;
      loadInto(L, App.clip(id));
      owner.set(id, L);
    }
    const used = new Set(owner.values());
    layers.forEach((L) => { if (!used.has(L)) hideLayer(L); });

    // Transición en curso.
    let p = 0, type = null;
    if (act.length === 2) {
      const inc = act[1];
      p = clamp((t - inc.start) / Math.max(inc.tIn, 1e-3), 0, 1);
      type = inc.transIn;
    }
    flashEl.style.opacity = '0';

    act.forEach((it, k) => {
      const L = owner.get(it.clip.id);
      if (!L) return;
      const c = it.clip;
      resetLayerStyle(L);
      L.root.style.zIndex = String(k + 1);
      applyLook(L, c);
      layoutLayer(L, c);
      const local = t - it.start;
      const env = fadeEnv(c, local, it.dur);
      let op = env, gain = c.muted ? 0 : c.volume * env;
      if (act.length === 2) {
        const incoming = k === 1;
        const q = incoming ? p : 1 - p;
        gain *= q;
        if (type === 'fade') { if (incoming) op *= p; }
        else if (type === 'fadeblack' || type === 'fadewhite') {
          op *= incoming ? (p >= 0.5 ? 1 : 0) : (p < 0.5 ? 1 : 0);
          flashEl.style.background = type === 'fadeblack' ? '#000' : '#fff';
          flashEl.style.opacity = String(1 - Math.abs(2 * p - 1));
        } else if (type === 'wipeleft') { if (incoming) L.root.style.clipPath = `inset(0 0 0 ${(1 - p) * 100}%)`; }
        else if (type === 'wiperight') { if (incoming) L.root.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`; }
        else if (type === 'slideleft') L.root.style.transform = `translateX(${incoming ? (1 - p) * 100 : -p * 100}%)`;
        else if (type === 'slideright') L.root.style.transform = `translateX(${incoming ? -(1 - p) * 100 : p * 100}%)`;
        else if (type === 'circleopen') { if (incoming) L.root.style.clipPath = `circle(${p * 72}% at 50% 50%)`; }
      }
      L.root.style.opacity = String(op);
      const expected = c.in + local * c.speed;
      const srcEnd = Math.max(0, (L.video.duration || 1e9) - 0.01);
      if (L.ready) {
        if (playing && expected >= srcEnd) { if (!L.video.paused && L.video.ended) L.video.pause(); }
        else sync(L.video, clamp(expected, 0, srcEnd), playing, clamp(c.speed, 0.0625, 16));
      }
      setGain(L, L.video, gain);
    });

    if (pre) {
      const L = owner.get(pre.clip.id);
      if (L) {
        L.root.style.visibility = 'hidden';
        applyLook(L, pre.clip);
        layoutLayer(L, pre.clip);
        if (!L.video.paused) L.video.pause();
        if (L.ready && Math.abs(L.video.currentTime - pre.clip.in) > 0.05 && !L.video.seeking) L.video.currentTime = pre.clip.in;
      }
    }
    return act.length ? owner.get(act[0].clip.id) : null;
  }

  function renderAudio(t, playing) {
    const ids = new Set(state.audioClips.map((a) => a.id));
    for (const [id, A] of audioEls) {
      if (!ids.has(id)) { A.el.pause(); A.el.removeAttribute('src'); A.el.load(); audioEls.delete(id); }
    }
    for (const a of state.audioClips) {
      let A = audioEls.get(a.id);
      const m = App.media(a.mediaId);
      if (!m || !m.info) continue;
      if (!A) {
        const el = new Audio();
        el.crossOrigin = 'anonymous';
        el.preload = 'auto';
        el.src = m.info.url;
        A = { el, gain: null, src: null, url: m.info.url };
        audioEls.set(a.id, A);
        connectAudio(A);
      }
      const len = a.out - a.in;
      const local = t - a.start;
      const active = playing && P.mode === 'sequence' && local >= 0 && local < len;
      if (!active) { if (!A.el.paused) A.el.pause(); continue; }
      let g = App.audioGain(a);
      if (a.fadeIn > 0) g *= clamp(local / a.fadeIn, 0, 1);
      if (a.fadeOut > 0) g *= clamp((len - local) / a.fadeOut, 0, 1);
      setGain(A, A.el, g);
      if (A.el.readyState >= 1) sync(A.el, a.in + local, true, 1);
    }
  }

  let textsEmpty = false;
  function renderTexts(t) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(stageSize.w * dpr), H = Math.round(stageSize.h * dpr);
    const resized = textCanvas.width !== W || textCanvas.height !== H;
    // Sin textos no se redibuja la capa en cada fotograma (a pantalla completa es grande).
    if (!state.textClips.length && textsEmpty && !resized) return;
    if (resized) { textCanvas.width = W; textCanvas.height = H; }
    const ctx = textCanvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    textsEmpty = !state.textClips.length;
    if (P.mode !== 'sequence') return;
    const sel = App.selectedText();
    for (const x of state.textClips) {
      const a = App.text.alphaAt(x, t);
      const show = a > 0 || (sel === x && !P.playing);
      if (!show) continue;
      App.text.draw(ctx, x, W, H, a > 0 ? a : 0.45);
      if (sel === x && !P.playing) {
        const m = App.text.measure(ctx, x, W, H);
        ctx.save();
        ctx.strokeStyle = 'rgba(169,157,255,.95)';
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.lineWidth = 1.5 * dpr;
        const pad = 6 * dpr;
        ctx.strokeRect(m.x - pad, m.y - pad, m.bw + pad * 2, m.bh + pad * 2);
        ctx.restore();
      }
    }
    textCanvas.classList.toggle('interactive', !!sel && !P.playing && !P.cropEdit);
  }

  function renderFrame(t, playing) {
    if (P.mode === 'source') return null;
    const base = renderSequence(t, playing);
    renderAudio(t, playing);
    renderTexts(t);
    return base;
  }

  // ------------------------------------------------------------------ transporte
  function updatePlayButton() {
    $('#btn-play').innerHTML = icon(P.playing ? 'pause' : 'play');
  }

  P.play = function () {
    ensureAudio();
    if (P.mode === 'source') {
      const v = layers[0].video;
      if (P.srcOut != null && v.currentTime >= P.srcOut - 0.02) v.currentTime = P.srcIn || 0;
      P.playing = true;
      updatePlayButton();
      v.play().catch(() => {});
      return;
    }
    const end = P.endTime();
    if (end <= 0) return;
    if (state.playhead >= end - 0.02) state.playhead = 0;
    P.playing = true;
    clock = { wall: now(), head: state.playhead };
    updatePlayButton();
  };

  P.pause = function () {
    P.playing = false;
    layers.forEach((L) => { if (!L.video.paused) L.video.pause(); });
    audioEls.forEach((A) => { if (!A.el.paused) A.el.pause(); });
    updatePlayButton();
  };

  P.toggle = () => (P.playing ? P.pause() : P.play());

  P.seek = function (t) {
    if (P.mode !== 'sequence') P.setMode('sequence');
    state.playhead = clamp(t, 0, Math.max(0, P.endTime()));
    clock = { wall: now(), head: state.playhead };
    App.timeline.updatePlayhead();
    updateClock();
    renderFrame(state.playhead, P.playing);
  };

  P.stepFrame = function (dir) {
    P.pause();
    if (P.mode === 'source') {
      const m = App.media(P.sourceMediaId);
      const v = layers[0].video;
      v.currentTime = clamp(v.currentTime + dir / (m.info.fps || 30), 0, m.info.duration);
      return;
    }
    P.seek(state.playhead + dir / P.outFps());
  };

  P.skip = function (sec) {
    if (P.mode === 'source') { const v = layers[0].video; v.currentTime = clamp(v.currentTime + sec, 0, v.duration || 0); return; }
    P.seek(state.playhead + sec);
  };

  P.toStart = () => (P.mode === 'source' ? (layers[0].video.currentTime = P.srcIn || 0) : P.seek(0));
  P.toEnd = () => (P.mode === 'source' ? (layers[0].video.currentTime = P.srcOut ?? (layers[0].video.duration || 0)) : P.seek(P.endTime()));

  function tick() {
    if (P.mode === 'sequence') {
      if (P.playing) {
        let t = clock.head + (now() - clock.wall);
        const seq = P.sequence();
        // El vídeo solo marca el ritmo mientras el cabezal está dentro de él; después
        // (música que sigue tras el vídeo) manda el reloj de pared.
        const act = state.playhead < seq.total - 0.02 ? activeItems(seq, state.playhead) : [];
        const L = act.length ? layers.find((x) => x.clipId === act[0].clip.id) : null;
        if (L && L.root.style.visibility !== 'hidden' && !L.video.ended) {
          const v = L.video;
          // Solo se congela el reloj si el vídeo de verdad no tiene imagen. Antes bastaba con que
          // fuera justo de datos (readyState < 3), algo frecuente a pantalla completa con la GPU
          // ocupada, y todo avanzaba a cámara lenta. Si se para, su currentTime tampoco avanza.
          if (!L.ready || v.seeking || v.readyState < 2) {
            // El vídeo aún no está listo: se congela el reloj para no adelantarse.
            t = state.playhead;
            clock = { wall: now(), head: t };
          } else if (!v.paused) {
            const it = act[0];
            const tv = it.start + (v.currentTime - it.clip.in) / it.clip.speed;
            if (Math.abs(tv - t) < 0.3) { t = tv; clock = { wall: now(), head: t }; }
          }
        }
        const end = P.endTime();
        if (t >= end) { t = end; P.pause(); }
        state.playhead = Math.max(0, t);
        App.timeline.updatePlayhead(true);
        updateClock();
      }
      renderFrame(state.playhead, P.playing);
    } else if (P.playing) {
      const v = layers[0].video;
      if ((P.srcOut != null && v.currentTime >= P.srcOut) || v.ended) P.pause();
      updateClock();
    }
    requestAnimationFrame(tick);
  }

  function updateClock() {
    const fps = P.outFps();
    let cur, total;
    if (P.mode === 'source') { const v = layers[0].video; cur = v.currentTime || 0; total = v.duration || 0; }
    else { cur = state.playhead; total = P.endTime(); }
    $('#tc-current').textContent = Core.formatTimecode(cur, fps);
    $('#tc-total').textContent = Core.formatTimecode(total, fps);
    const f = total ? clamp(cur / total, 0, 1) : 0;
    $('#scrub-fill').style.width = `${f * 100}%`;
    $('#scrub-knob').style.left = `${f * 100}%`;
    const range = $('#scrub-range');
    if (P.mode === 'source' && total && (P.srcIn != null || P.srcOut != null)) {
      const a = (P.srcIn || 0) / total, b = (P.srcOut ?? total) / total;
      range.hidden = false;
      range.style.left = `${a * 100}%`;
      range.style.width = `${(b - a) * 100}%`;
    } else range.hidden = true;
  }
  P.updateClock = updateClock;

  // ------------------------------------------------------------------ modos
  function updateModeUI() {
    const badge = $('#mode-badge');
    const src = P.mode === 'source';
    badge.classList.toggle('source', src);
    badge.textContent = src ? 'Fuente · volver' : 'Secuencia';
    badge.title = src ? 'Vista previa del archivo. Haz clic para volver a la secuencia.' : '';
    $('#btn-src-add').hidden = !src;
    $('#sel-aspect').disabled = src;
    $$('#fit-toggle button').forEach((b) => (b.disabled = src));
    if (src) { P.cropEdit = false; cropLayer.hidden = true; }
    $('#audio-poster').hidden = true;
  }

  P.setSourceMedia = function (mediaId) {
    const m = App.media(mediaId);
    if (!m || !m.info) return;
    if (P.playing) P.pause();
    P.mode = 'source';
    P.sourceMediaId = mediaId;
    P.srcIn = null;
    P.srcOut = null;
    updateModeUI();
    $('#stage-empty').hidden = true;
    hideLayer(layers[1]);
    audioEls.forEach((A) => A.el.pause());
    const L = layers[0];
    resetLayerStyle(L);
    L.clipId = null;
    L.colorKey = null;
    L.video.style.filter = 'none';
    L.vignette.style.background = 'none';
    flashEl.style.opacity = '0';
    renderTexts(0);
    const isAudio = m.info.kind === 'audio';
    $('#audio-poster').hidden = !isAudio;
    if (isAudio) {
      $('#ap-name').textContent = m.info.title || m.name;
      $('#ap-wave').style.backgroundImage = m.wave ? `url("${m.wave}")` : 'none';
    }
    const src = srcFor(m);
    P.layout();
    if (!src) return;
    setSrc(L, src);
    const go = () => { L.video.playbackRate = 1; L.video.currentTime = 0; updateClock(); };
    if (L.ready) go(); else L.video.addEventListener('loadedmetadata', go, { once: true });
    setGain(L, L.video, 1);
  };

  P.setMode = function (mode) {
    if (mode === P.mode) return;
    if (P.playing) P.pause();
    P.mode = mode;
    if (mode === 'sequence') {
      P.sourceMediaId = null;
      state.selectedMediaId = null;
      layers.forEach((L) => { L.clipId = null; L.colorKey = null; });
      App.library.render();
    }
    updateModeUI();
    P.refresh();
  };

  P.markSource = function (which) {
    const t = layers[0].video.currentTime || 0;
    if (which === 'in') { P.srcIn = t; if (P.srcOut != null && P.srcOut <= t) P.srcOut = null; }
    else { P.srcOut = t; if (P.srcIn != null && P.srcIn >= t) P.srcIn = null; }
    updateClock();
  };

  P.addSourceToTimeline = function () {
    const m = App.media(P.sourceMediaId);
    if (!m) return;
    const inT = P.srcIn || 0, outT = P.srcOut ?? m.info.duration;
    if (outT - inT < 0.05) return toast('El rango marcado es demasiado corto', 'warn');
    if (m.info.kind === 'audio') {
      const a = App.createAudioClip(m, { start: state.playhead });
      a.in = inT;
      a.out = outT;
      state.audioClips.push(a);
      state.selectedId = a.id;
      state.selKind = 'audio';
    } else {
      const c = App.createClip(m, inT, outT);
      state.clips.push(c);
      state.selectedId = c.id;
      state.selKind = 'video';
    }
    App.commit();
    toast('Fragmento añadido a la línea de tiempo', 'ok', 2000);
  };

  // ------------------------------------------------------------------ refresco
  P.refresh = function () {
    if (P.mode === 'source') { P.layout(); return; }
    const end = P.endTime();
    state.playhead = clamp(state.playhead, 0, Math.max(0, end));
    if (P.cropEdit && !App.selectedClip()) P.setCropEdit(false);
    P.layout();
    renderFrame(state.playhead, P.playing);
    updateClock();
  };

  P.refreshLook = function () {
    if (P.mode === 'sequence') renderFrame(state.playhead, P.playing);
  };

  // ------------------------------------------------------------------ disposición
  P.layout = function () {
    const wrap = $('#stage-wrap');
    const W = Math.max(50, wrap.clientWidth - (document.fullscreenElement ? 0 : 28));
    const H = Math.max(50, wrap.clientHeight - (document.fullscreenElement ? 0 : 28));
    let aspect, info = '';
    if (P.mode === 'source') {
      const m = App.media(P.sourceMediaId);
      aspect = m && m.info.width ? m.info.width / m.info.height : 16 / 9;
      if (m) info = m.info.kind === 'audio' ? `${Core.formatTime(m.info.duration, 1)} · ${m.name}` : `${m.info.width}×${m.info.height} · ${Core.fpsLabel(m.info.fpsStr)} fps · ${m.name}`;
    } else {
      const s = Core.normalizeSettings(state.settings);
      const clips = App.jobClips();
      const d = Core.outputDimensions(s, clips);
      aspect = d.width / d.height;
      if (clips.length) info = `Salida ${d.width}×${d.height} · ${Core.fpsLabel(Core.outputFps(s, clips))} fps`;
    }
    $('#out-info').textContent = info;
    let sw = W, sh = W / aspect;
    if (sh > H) { sh = H; sw = H * aspect; }
    sw = Math.round(sw);
    sh = Math.round(sh);
    stage.style.width = `${sw}px`;
    stage.style.height = `${sh}px`;
    stageSize = { w: sw, h: sh };
    if (P.mode === 'source') {
      const L = layers[0];
      box(L.content, 0, 0, sw, sh);
      box(L.video, 0, 0, sw, sh);
      L.video.style.transform = 'none';
    }
  };

  P.toggleFullscreen = function () {
    const wrap = $('#stage-wrap');
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.requestFullscreen().catch(() => {});
  };

  // ------------------------------------------------------------------ encuadre
  function positionCropBox() {
    const c = App.selectedClip();
    if (!c) return;
    const cr = c.crop || FULL, R = P.frameRect;
    box(cropBox, R.x + cr.x * R.w, R.y + cr.y * R.h, cr.w * R.w, cr.h * R.h);
    cropBox.classList.toggle('locked', !!P.cropAspect);
    $('#crop-size').textContent = `${Math.round(cr.w * P.framePx.w)} × ${Math.round(cr.h * P.framePx.h)}`;
  }

  P.setCropEdit = function (on) {
    if (on) {
      const sel = App.selectedClip();
      if (!sel) return;
      if (P.mode !== 'sequence') P.setMode('sequence');
      App.select(sel.id, { kind: 'video', seek: true });
      if (P.playing) P.pause();
    }
    P.cropEdit = !!on;
    cropLayer.hidden = !P.cropEdit;
    P.refresh();
    App.inspector.syncCropButton && App.inspector.syncCropButton();
  };

  P.setCropAspect = function (ratio) {
    P.cropAspect = ratio;
    const c = App.selectedClip();
    if (!c || !ratio) { if (P.cropEdit) positionCropBox(); return; }
    const m = App.clipMedia(c);
    const rot = (c.rotate || 0) % 180 !== 0;
    const fa = rot ? m.info.height / m.info.width : m.info.width / m.info.height;
    let w = 1, hh = 1;
    if (ratio > fa) hh = fa / ratio; else w = ratio / fa;
    c.crop = { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh };
    App.commit();
  };

  function initCrop() {
    cropBox.addEventListener('pointerdown', (e) => {
      const c = App.selectedClip();
      if (!c || e.button !== 0) return;
      e.preventDefault();
      cropBox.setPointerCapture(e.pointerId);
      const handle = e.target.dataset.h || 'move';
      const start = { x: e.clientX, y: e.clientY, crop: { ...(c.crop || FULL) } };
      const R = P.frameRect, lock = P.cropAspect, fa = P.frameAspect;
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / R.w, dy = (ev.clientY - start.y) / R.h;
        let { x, y, w, h: hh } = start.crop;
        if (handle === 'move') {
          x = clamp(x + dx, 0, 1 - w);
          y = clamp(y + dy, 0, 1 - hh);
        } else {
          let l = x, t = y, r = x + w, b = y + hh;
          if (handle.includes('w')) l = clamp(l + dx, 0, r - 0.05);
          if (handle.includes('e')) r = clamp(r + dx, l + 0.05, 1);
          if (handle.includes('n')) t = clamp(t + dy, 0, b - 0.05);
          if (handle.includes('s')) b = clamp(b + dy, t + 0.05, 1);
          x = l; y = t; w = r - l; hh = b - t;
          if (lock) {
            let nh = (w * fa) / lock;
            const maxH = handle.includes('n') ? b : 1 - y;
            if (nh > maxH) { nh = maxH; w = (nh * lock) / fa; if (handle.includes('w')) x = r - w; }
            if (handle.includes('n')) y = b - nh;
            hh = nh;
          }
        }
        c.crop = { x, y, w, h: hh };
        positionCropBox();
      };
      const up = () => {
        cropBox.removeEventListener('pointermove', move);
        cropBox.removeEventListener('pointerup', up);
        const cr = c.crop;
        if (cr && cr.x < 0.001 && cr.y < 0.001 && cr.w > 0.999 && cr.h > 0.999) c.crop = null;
        App.commit();
      };
      cropBox.addEventListener('pointermove', move);
      cropBox.addEventListener('pointerup', up);
    });
  }

  // Arrastrar el texto seleccionado directamente en el visor.
  function initTextDrag() {
    textCanvas.addEventListener('pointerdown', (e) => {
      const t = App.selectedText();
      if (!t || e.button !== 0) return;
      textCanvas.setPointerCapture(e.pointerId);
      textDrag = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y, moved: false };
      const move = (ev) => {
        textDrag.moved = true;
        t.x = clamp(textDrag.ox + (ev.clientX - textDrag.x) / stageSize.w, 0, 1);
        t.y = clamp(textDrag.oy + (ev.clientY - textDrag.y) / stageSize.h, 0, 1);
        renderTexts(state.playhead);
      };
      const up = () => {
        textCanvas.removeEventListener('pointermove', move);
        textCanvas.removeEventListener('pointerup', up);
        if (textDrag.moved) App.commit();
        textDrag = null;
      };
      textCanvas.addEventListener('pointermove', move);
      textCanvas.addEventListener('pointerup', up);
    });
  }

  // ------------------------------------------------------------------ init
  P.init = function () {
    stage = $('#stage');
    flashEl = $('#flash');
    textCanvas = $('#text-layer');
    cropLayer = $('#crop-layer');
    cropBox = $('#crop-box');
    layers.push(makeLayer($('#layer-0'), 0), makeLayer($('#layer-1'), 1));
    layers[0].video.addEventListener('pause', () => { if (P.mode === 'source' && P.playing) { P.playing = false; updatePlayButton(); } });
    layers[0].video.addEventListener('seeked', () => { if (P.mode === 'source') updateClock(); });

    $('#btn-play').addEventListener('click', P.toggle);
    $('#btn-prev').addEventListener('click', () => P.stepFrame(-1));
    $('#btn-next').addEventListener('click', () => P.stepFrame(1));
    $('#btn-start').addEventListener('click', P.toStart);
    $('#btn-end').addEventListener('click', P.toEnd);
    $('#btn-mark-in').addEventListener('click', () => (P.mode === 'source' ? P.markSource('in') : App.markAtPlayhead('in')));
    $('#btn-mark-out').addEventListener('click', () => (P.mode === 'source' ? P.markSource('out') : App.markAtPlayhead('out')));
    $('#btn-src-add').addEventListener('click', P.addSourceToTimeline);
    $('#mode-badge').addEventListener('click', () => P.setMode('sequence'));
    $('#btn-fullscreen').addEventListener('click', P.toggleFullscreen);
    document.addEventListener('fullscreenchange', () => setTimeout(() => P.refresh(), 50));

    const vol = $('#vol-slider');
    paintRange(vol);
    vol.addEventListener('input', () => { P.previewVolume = Number(vol.value); applyMaster(); });
    $('#btn-vol').addEventListener('click', () => {
      P.previewMuted = !P.previewMuted;
      $('#btn-vol').innerHTML = icon(P.previewMuted ? 'mute' : 'volume');
      applyMaster();
      layers.forEach((L) => { if (!L.gain) L.video.muted = P.previewMuted; });
    });

    const scrub = $('#scrubber');
    scrub.addEventListener('pointerdown', (e) => {
      scrub.setPointerCapture(e.pointerId);
      if (P.playing) P.pause();
      const go = (ev) => {
        const r = scrub.getBoundingClientRect();
        const f = clamp((ev.clientX - r.left) / r.width, 0, 1);
        if (P.mode === 'source') { const v = layers[0].video; v.currentTime = f * (v.duration || 0); updateClock(); }
        else P.seek(f * P.endTime());
      };
      go(e);
      const up = () => { scrub.removeEventListener('pointermove', go); scrub.removeEventListener('pointerup', up); };
      scrub.addEventListener('pointermove', go);
      scrub.addEventListener('pointerup', up);
    });

    stage.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('application/x-fotograma-media')) return;
      e.preventDefault();
      stage.classList.add('drag-over');
    });
    stage.addEventListener('dragleave', () => stage.classList.remove('drag-over'));
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      stage.classList.remove('drag-over');
      const mid = e.dataTransfer.getData('application/x-fotograma-media');
      if (mid) return App.addClips([mid]);
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
      if (paths.length) App.library.importPaths(paths, { toTimeline: true });
    });

    initCrop();
    initTextDrag();
    new ResizeObserver(() => P.refresh()).observe($('#stage-wrap'));
    updatePlayButton();
    requestAnimationFrame(tick);
  };
})();
