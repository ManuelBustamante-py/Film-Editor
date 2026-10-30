/* Línea de tiempo multipista: textos, vídeo (secuencia magnética con transiciones)
   y pistas de audio libres. */
(function () {
  const App = window.App;
  const { state } = App;
  const T = (App.timeline = {});
  const MIN_ZOOM = 2, MAX_ZOOM = 600;
  const MIN_LEN = 0.05;
  let scrollEl, bodyEl, contentEl, rowsEl, headsEl, ruler, rulerHeadEl, playheadEl, insertEl;
  let rafPending = false;
  let popover = null;

  const zoomToSlider = (z) => Math.round((Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 1000);
  const sliderToZoom = (v) => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v / 1000);
  const sel = (kind, id) => state.selKind === kind && state.selectedId === id;

  T.scheduleRender = function () {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; T.render(); });
  };

  // ------------------------------------------------------------------ clips
  function waveStyle(el, m, inT, outT, w) {
    if (!m.wave) return;
    const full = (w * m.info.duration) / Math.max(outT - inT, 1e-3);
    el.style.backgroundImage = `url("${m.wave}")`;
    el.style.backgroundSize = `${full}px 100%`;
    el.style.backgroundPosition = `-${(inT / m.info.duration) * full}px 0`;
  }

  function videoNode(it, zoom, rowH) {
    const c = it.clip;
    const m = App.clipMedia(c);
    const w = Math.max(4, it.dur * zoom);
    const el = h('div', {
      class: `clip v${sel('video', c.id) ? ' selected' : ''}`,
      style: { left: `${it.start * zoom}px`, width: `${w}px`, zIndex: String(1 + it.i) },
      'data-id': c.id, 'data-kind': 'video',
    });
    const strip = h('div', { class: 'clip-strip' });
    const stripH = Math.max(20, Math.round((rowH - 8) * 0.62));
    const tileW = Math.round((stripH * 16) / 9);
    if (m.thumbs && m.thumbs.strip) {
      const n = m.thumbs.tiles;
      const count = Math.min(300, Math.ceil(w / tileW));
      for (let j = 0; j < count; j++) {
        const tSrc = c.in + (((j + 0.5) * tileW) / zoom) * c.speed;
        const idx = clamp(Math.floor((tSrc / m.info.duration) * n), 0, n - 1);
        strip.appendChild(h('div', { class: 'tile', style: {
          width: `${tileW}px`, backgroundImage: `url("${m.thumbs.strip}")`,
          backgroundSize: `${n * tileW}px 100%`, backgroundPosition: `-${idx * tileW}px 0`,
        } }));
      }
    } else if (m.thumbs) strip.style.background = `url("${m.thumbs.poster}") left center / auto 100% repeat-x`;
    el.appendChild(strip);
    const badges = [];
    if (Math.abs(c.speed - 1) > 1e-3) badges.push(h('span', { class: 'cb' }, `${+c.speed.toFixed(2)}×`));
    if (!Core.isDefaultColor(c.color)) badges.push(h('span', { class: 'cb fx' }, 'FX'));
    if (c.rotate || c.flipH || c.flipV || c.crop) badges.push(h('span', { class: 'cb' }, '⤢'));
    if (c.muted) badges.push(h('span', { class: 'cb mute' }, 'MUTE'));
    el.appendChild(h('div', { class: 'clip-label' }, ...badges, h('span', { class: 'name' }, m.name)));
    const wave = h('div', { class: `clip-wave${m.info.hasAudio && !c.muted ? '' : ' none'}` });
    if (m.info.hasAudio && !c.muted) {
      // La forma de onda se estira con la velocidad del clip.
      waveStyle(wave, m, c.in, c.out, w);
      wave.style.opacity = String(clamp(0.35 + c.volume * 0.65, 0.35, 1));
    }
    el.appendChild(wave);
    if (c.fadeIn > 0) el.appendChild(h('div', { class: 'fade in', style: { width: `${Math.min(w, c.fadeIn * zoom)}px` } }));
    if (c.fadeOut > 0) el.appendChild(h('div', { class: 'fade out', style: { width: `${Math.min(w, c.fadeOut * zoom)}px` } }));
    el.appendChild(h('div', { class: 'clip-handle l', 'data-side': 'l' }));
    el.appendChild(h('div', { class: 'clip-handle r', 'data-side': 'r' }));
    return el;
  }

  function audioNode(a, zoom) {
    const m = App.media(a.mediaId);
    const w = Math.max(4, (a.out - a.in) * zoom);
    const silent = App.audioGain(a) === 0;
    const el = h('div', {
      class: `clip a${sel('audio', a.id) ? ' selected' : ''}${silent ? ' muted' : ''}`,
      style: { left: `${a.start * zoom}px`, width: `${w}px` },
      'data-id': a.id, 'data-kind': 'audio',
    });
    const badges = [];
    if (Math.abs(a.volume - 1) > 1e-3) badges.push(h('span', { class: 'cb' }, `${Math.round(a.volume * 100)}%`));
    if (a.muted) badges.push(h('span', { class: 'cb mute' }, 'MUTE'));
    el.appendChild(h('div', { class: 'clip-label' }, ...badges, h('span', { class: 'name' }, m ? m.info.title || m.name : '?')));
    const wave = h('div', { class: 'clip-wave' });
    if (m) waveStyle(wave, m, a.in, a.out, w);
    el.appendChild(wave);
    if (a.fadeIn > 0) el.appendChild(h('div', { class: 'fade in', style: { width: `${Math.min(w, a.fadeIn * zoom)}px` } }));
    if (a.fadeOut > 0) el.appendChild(h('div', { class: 'fade out', style: { width: `${Math.min(w, a.fadeOut * zoom)}px` } }));
    el.appendChild(h('div', { class: 'clip-handle l', 'data-side': 'l' }));
    el.appendChild(h('div', { class: 'clip-handle r', 'data-side': 'r' }));
    return el;
  }

  function textNode(t, zoom) {
    const w = Math.max(4, t.duration * zoom);
    return h('div', {
      class: `clip t${sel('text', t.id) ? ' selected' : ''}`,
      style: { left: `${t.start * zoom}px`, width: `${w}px` },
      'data-id': t.id, 'data-kind': 'text',
    },
    h('div', { class: 'ttext' }, t.text.replace(/\n/g, ' ⏎ ') || '(vacío)'),
    h('div', { class: 'clip-handle l', 'data-side': 'l' }),
    h('div', { class: 'clip-handle r', 'data-side': 'r' }));
  }

  // ------------------------------------------------------------------ cabeceras
  function trackHead(t) {
    const name = h('span', { class: 'nm', title: 'Doble clic para renombrar' }, t.name);
    name.addEventListener('dblclick', () => {
      const inp = h('input', { type: 'text', class: 'rename', value: t.name });
      name.replaceWith(inp);
      inp.focus();
      inp.select();
      const done = () => { t.name = inp.value.trim() || t.name; App.commit(); };
      inp.addEventListener('blur', done);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = t.name; inp.blur(); } });
    });
    const vol = h('input', { type: 'range', class: 'tvol', min: 0, max: 2, step: 0.01, value: t.volume, title: 'Volumen de la pista' });
    paintRange(vol);
    vol.addEventListener('input', () => { t.volume = Number(vol.value); vol.title = `Volumen ${Math.round(t.volume * 100)}%`; });
    vol.addEventListener('change', () => App.commit());
    vol.addEventListener('dblclick', () => { t.volume = 1; App.commit(); });
    return h('div', { class: 'tl-head audio tl-ahead' },
      h('div', { class: 'hl', html: icon('music') }, name),
      h('div', { class: 'ctrls' },
        h('button', { class: `th-btn m${t.muted ? ' on' : ''}`, title: 'Silenciar pista', onclick: () => { t.muted = !t.muted; App.commit(); } }, 'M'),
        h('button', { class: `th-btn s${t.solo ? ' on' : ''}`, title: 'Solo', onclick: () => { t.solo = !t.solo; App.commit(); } }, 'S'),
        vol,
        h('button', { class: 'th-btn', title: 'Eliminar pista', html: icon('x'), onclick: () => App.removeTrack(t.id) })));
  }

  // ------------------------------------------------------------------ render
  T.render = function () {
    const zoom = state.zoom;
    const seq = App.player.sequence();
    const end = App.contentEnd();
    const viewW = scrollEl.clientWidth;
    const width = Math.max(viewW, end * zoom + 400);
    contentEl.style.width = `${width}px`;
    rowsEl.innerHTML = '';
    headsEl.innerHTML = '';

    // Textos
    headsEl.appendChild(h('div', { class: 'tl-head text tl-thead' },
      h('div', { class: 'hl', html: icon('type') }, h('span', { class: 'nm' }, 'Textos')),
      h('button', { class: 'th-btn', title: 'Añadir texto en el cabezal', html: icon('plus'), onclick: App.addText })));
    const tRow = h('div', { class: 'tl-row text', 'data-row': 'text' });
    state.textClips.forEach((t) => tRow.appendChild(textNode(t, zoom)));
    rowsEl.appendChild(tRow);

    // Vídeo
    headsEl.appendChild(h('div', { class: 'tl-head video tl-vhead' },
      h('div', { class: 'hl', html: icon('film') }, h('span', { class: 'nm' }, 'Vídeo')), h('span', { class: 'tag' }, 'V1')));
    const vRow = h('div', { class: 'tl-row video', 'data-row': 'video' });
    const rowH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-video'), 10) || 86;
    if (!seq.items.length) vRow.appendChild(h('div', { class: 'tl-empty' }, 'Arrastra vídeos aquí desde la biblioteca o el explorador'));
    seq.items.forEach((it) => vRow.appendChild(videoNode(it, zoom, rowH)));
    seq.items.forEach((it) => {
      if (it.i === 0) return;
      if (it.tIn > 0) {
        vRow.appendChild(h('div', {
          class: 'tl-trans', 'data-trans': it.i - 1, html: icon('transition'),
          title: `${Core.TRANSITION_MAP[it.transIn].label} · ${it.tIn.toFixed(2)} s`,
          style: { left: `${it.start * zoom}px`, width: `${Math.max(14, it.tIn * zoom)}px` },
        }));
      } else {
        vRow.appendChild(h('div', { class: 'tl-junction', 'data-trans': it.i - 1, html: icon('plus'), title: 'Añadir transición', style: { left: `${it.start * zoom}px` } }));
      }
    });
    if (seq.total > 0 && end > seq.total) vRow.appendChild(h('div', { class: 'tl-after', style: { left: `${seq.total * zoom}px`, width: `${(end - seq.total) * zoom}px` }, title: 'Fuera del vídeo: no se exporta' }));
    rowsEl.appendChild(vRow);

    // Audio
    state.tracks.forEach((t) => {
      headsEl.appendChild(trackHead(t));
      const row = h('div', { class: 'tl-row audio', 'data-row': 'audio', 'data-track': t.id });
      state.audioClips.filter((a) => a.trackId === t.id).forEach((a) => row.appendChild(audioNode(a, zoom)));
      rowsEl.appendChild(row);
    });
    headsEl.appendChild(h('div', { class: 'tl-add-track' },
      h('button', { class: 'btn small ghost block', html: icon('plus'), onclick: () => App.addTrack() }, 'Pista de audio')));

    const nItems = seq.items.length + state.audioClips.length + state.textClips.length;
    $('#tl-info').textContent = nItems ? `${Core.formatTime(seq.total, 2)} de vídeo` : '';
    $('#tl-dup').disabled = !state.selectedId;
    $('#tl-del').disabled = !state.selectedId;
    $('#tl-split').disabled = !nItems;
    $('#tl-snap').classList.toggle('active', state.snap);
    $('#tl-zoom').value = zoomToSlider(zoom);
    paintRange($('#tl-zoom'));
    insertEl.style.height = `${rowsEl.offsetHeight}px`;
    T.updatePlayhead();
  };

  // ------------------------------------------------------------------ regla
  function drawRuler() {
    const dpr = window.devicePixelRatio || 1;
    const w = ruler.clientWidth, hgt = 28;
    if (ruler.width !== Math.round(w * dpr)) { ruler.width = Math.round(w * dpr); ruler.height = hgt * dpr; }
    const ctx = ruler.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const zoom = state.zoom, left = scrollEl.scrollLeft;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const major = steps.find((s) => s * zoom >= 80) || 3600;
    const minor = major / (major >= 60 ? 6 : major === 15 ? 3 : 5);
    const t0 = Math.floor(left / zoom / minor) * minor;
    const t1 = (left + w) / zoom;
    const total = App.player.sequence().total;
    if (total) {
      ctx.fillStyle = 'rgba(139,123,255,.18)';
      const xe = Math.min(w, total * zoom - left);
      if (xe > 0) ctx.fillRect(0, hgt - 3, xe, 3);
    }
    ctx.font = '10.5px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = 'top';
    for (let t = t0; t <= t1; t += minor) {
      const x = Math.round(t * zoom - left) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.12)';
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 12 : 20);
      ctx.lineTo(x, hgt);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#8b93a3';
        ctx.fillText(Core.formatTime(t, major < 1 ? 1 : 0), x + 4, 3);
      }
    }
    placeRulerHead();
  }

  // La marca del cabezal en la regla es un elemento aparte: sigue al cabezal sin redibujar la regla.
  let rulerHeadX = null;
  function placeRulerHead() {
    const x = Math.round((state.playhead * state.zoom - scrollEl.scrollLeft) * 2) / 2;
    if (x !== rulerHeadX) { rulerHeadX = x; rulerHeadEl.style.transform = `translateX(${x}px)`; }
  }

  // Durante la reproducción (follow) solo se mueve el cabezal, con transform (lo hace el
  // compositor, sin recalcular el diseño): leer la altura de las pistas y redibujar la regla en
  // cada fotograma le quitaba al vídeo el tiempo que necesitaba con el equipo cargado.
  let playheadX = null;
  T.updatePlayhead = function (follow) {
    const x = Math.round(state.playhead * state.zoom * 2) / 2;
    if (x !== playheadX) { playheadX = x; playheadEl.style.transform = `translateX(${x}px)`; }
    if (follow) {
      const l = scrollEl.scrollLeft, w = scrollEl.clientWidth;
      // Al desplazarse, el evento scroll redibuja la regla.
      if (x > l + w - 40 || x < l) scrollEl.scrollLeft = Math.max(0, x - 60);
      placeRulerHead();
      return;
    }
    playheadEl.style.height = `${rowsEl.offsetHeight}px`;
    drawRuler();
  };

  // ------------------------------------------------------------------ zoom
  T.setZoom = function (z, anchorX) {
    const old = state.zoom;
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(z - old) < 1e-3) return;
    const ax = anchorX == null ? state.playhead * old - scrollEl.scrollLeft : anchorX;
    const t = (scrollEl.scrollLeft + ax) / old;
    state.zoom = z;
    T.render();
    scrollEl.scrollLeft = Math.max(0, t * z - ax);
    drawRuler();
  };
  T.zoomBy = (f) => T.setZoom(state.zoom * f);
  T.fit = function () {
    const total = App.contentEnd();
    if (!total) return;
    T.setZoom((scrollEl.clientWidth - 40) / total);
    scrollEl.scrollLeft = 0;
  };

  // ------------------------------------------------------------------ utilidades
  const timeAt = (clientX) => (clientX - contentEl.getBoundingClientRect().left) / state.zoom;

  function insertIndexAt(t, excludeIndex = -1) {
    const { items } = App.player.sequence();
    let idx = 0;
    items.forEach((it, i) => { if (i !== excludeIndex && it.start + it.dur / 2 < t) idx = i + 1; });
    return idx;
  }

  function showInsert(index) {
    const { items, total } = App.player.sequence();
    const x = index < items.length ? items[index].start : total;
    const vRow = rowsEl.querySelector('.tl-row.video');
    insertEl.hidden = false;
    insertEl.style.left = `${x * state.zoom}px`;
    insertEl.style.top = `${vRow.offsetTop}px`;
    insertEl.style.height = `${vRow.offsetHeight}px`;
  }

  function tip(text, x, y) {
    let el = $('.trim-tip');
    if (!text) { if (el) el.remove(); return; }
    if (!el) { el = h('div', { class: 'trim-tip' }); document.body.appendChild(el); }
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  // Puntos de anclaje para el imán.
  function snapPoints(excludeId) {
    const pts = [0, state.playhead];
    App.player.sequence().items.forEach((it) => pts.push(it.start, it.start + it.dur));
    state.audioClips.forEach((a) => { if (a.id !== excludeId) pts.push(a.start, a.start + a.out - a.in); });
    state.textClips.forEach((t) => { if (t.id !== excludeId) pts.push(t.start, t.start + t.duration); });
    return pts;
  }
  function snapLine(t) {
    let el = contentEl.querySelector('.snap-line');
    if (t == null) { if (el) el.remove(); return; }
    if (!el) { el = h('div', { class: 'snap-line' }); contentEl.appendChild(el); }
    el.style.left = `${t * state.zoom}px`;
  }
  // Devuelve el desplazamiento para que alguno de los bordes quede imantado.
  function snapDelta(edges, pts) {
    if (!state.snap) return { d: 0, at: null };
    const th = 8 / state.zoom;
    let best = { d: 0, at: null, dist: th };
    for (const e of edges) for (const p of pts) {
      const dist = Math.abs(p - e);
      if (dist < best.dist) best = { d: p - e, at: p, dist };
    }
    return best;
  }

  // ------------------------------------------------------------------ interacción
  function startScrub(e) {
    if (App.player.playing) App.player.pause();
    App.player.seek(timeAt(e.clientX));
    const move = (ev) => App.player.seek(timeAt(ev.clientX));
    const up = () => { contentEl.removeEventListener('pointermove', move); contentEl.removeEventListener('pointerup', up); };
    contentEl.addEventListener('pointermove', move);
    contentEl.addEventListener('pointerup', up);
  }

  function startVideoTrim(e, id, side) {
    const c = App.clip(id);
    if (!c) return;
    if (App.player.playing) App.player.pause();
    const m = App.clipMedia(c);
    const x0 = e.clientX, in0 = c.in, out0 = c.out;
    if (!sel('video', id)) App.select(id, { kind: 'video' });
    let moved = false;
    const move = (ev) => {
      moved = true;
      const ds = ((ev.clientX - x0) / state.zoom) * c.speed;
      const it = () => App.player.sequence().items.find((i) => i.clip.id === id);
      if (side === 'l') {
        c.in = clamp(in0 + ds, 0, c.out - MIN_LEN);
        App.player.seek(it().start);
      } else {
        c.out = clamp(out0 + ds, c.in + MIN_LEN, m.info.duration);
        const x = it();
        App.player.seek(x.start + x.dur - 0.001);
      }
      tip(`${side === 'l' ? 'Entrada' : 'Salida'} ${Core.formatTime(side === 'l' ? c.in : c.out)} · Duración ${Core.formatTime(Core.clipDuration(c))}`, ev.clientX, ev.clientY);
      T.scheduleRender();
    };
    const up = () => {
      contentEl.removeEventListener('pointermove', move);
      contentEl.removeEventListener('pointerup', up);
      tip(null);
      if (moved) App.commit();
    };
    contentEl.addEventListener('pointermove', move);
    contentEl.addEventListener('pointerup', up);
  }

  function startVideoPress(e, id) {
    const x0 = e.clientX, t0 = timeAt(e.clientX);
    const fromIndex = state.clips.findIndex((c) => c.id === id);
    if (!sel('video', id)) App.select(id, { kind: 'video' });
    let drag = null;
    const move = (ev) => {
      if (!drag && Math.abs(ev.clientX - x0) > 5) {
        const node = rowsEl.querySelector(`.clip[data-id="${id}"]`);
        if (node) node.classList.add('dragging');
        drag = h('div', { class: 'drag-ghost' }, App.clipMedia(App.clip(id)).name);
        document.body.appendChild(drag);
      }
      if (drag) {
        drag.style.left = `${ev.clientX}px`;
        drag.style.top = `${ev.clientY}px`;
        showInsert(insertIndexAt(timeAt(ev.clientX), fromIndex));
      }
    };
    const up = (ev) => {
      contentEl.removeEventListener('pointermove', move);
      contentEl.removeEventListener('pointerup', up);
      insertEl.hidden = true;
      if (drag) {
        drag.remove();
        // Índice de inserción en la lista original (moveClip descuenta el clip retirado).
        const to = insertIndexAt(timeAt(ev.clientX), fromIndex);
        if (to !== fromIndex && to !== fromIndex + 1) App.moveClip(fromIndex, to);
        else T.render();
      } else {
        if (App.player.playing) App.player.pause();
        App.player.seek(t0);
      }
    };
    contentEl.addEventListener('pointermove', move);
    contentEl.addEventListener('pointerup', up);
  }

  // Clips de audio y texto: mover (y cambiar de pista) o recortar.
  function startFree(e, kind, id, side) {
    const item = kind === 'audio' ? App.audioClip(id) : App.textClip(id);
    if (!item) return;
    if (App.player.playing) App.player.pause();
    if (!sel(kind, id)) App.select(id, { kind });
    const x0 = e.clientX, t0 = timeAt(e.clientX);
    const orig = { ...item };
    const len = () => (kind === 'audio' ? item.out - item.in : item.duration);
    const srcDur = kind === 'audio' ? App.media(item.mediaId).info.duration : Infinity;
    const pts = snapPoints(id);
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3 && !side) {
        if (kind !== 'audio' || Math.abs(ev.clientY - e.clientY) < 6) return;
      }
      moved = true;
      const dt = (ev.clientX - x0) / state.zoom;
      if (!side) {
        let start = Math.max(0, orig.start + dt);
        const L = kind === 'audio' ? orig.out - orig.in : orig.duration;
        const sn = snapDelta([start, start + L], pts);
        start = Math.max(0, start + sn.d);
        snapLine(sn.at);
        item.start = start;
        if (kind === 'audio') {
          const row = document.elementFromPoint(ev.clientX, ev.clientY);
          const r = row && row.closest('.tl-row.audio');
          if (r && r.dataset.track) item.trackId = r.dataset.track;
        }
        tip(`Inicio ${Core.formatTime(item.start)}`, ev.clientX, ev.clientY);
      } else if (side === 'l') {
        let ns = orig.start + dt;
        const sn = snapDelta([ns], pts);
        ns += sn.d;
        snapLine(sn.at);
        if (kind === 'audio') {
          const d = clamp(ns - orig.start, -orig.in, orig.out - orig.in - MIN_LEN);
          item.start = Math.max(0, orig.start + d);
          item.in = orig.in + (item.start - orig.start);
        } else {
          const d = clamp(ns - orig.start, -orig.start, orig.duration - 0.1);
          item.start = orig.start + d;
          item.duration = orig.duration - d;
        }
        tip(`Inicio ${Core.formatTime(item.start)} · Duración ${Core.formatTime(len())}`, ev.clientX, ev.clientY);
      } else {
        let ne = orig.start + (kind === 'audio' ? orig.out - orig.in : orig.duration) + dt;
        const sn = snapDelta([ne], pts);
        ne += sn.d;
        snapLine(sn.at);
        if (kind === 'audio') item.out = clamp(orig.in + (ne - orig.start), orig.in + MIN_LEN, srcDur);
        else item.duration = Math.max(0.1, ne - orig.start);
        tip(`Fin ${Core.formatTime(item.start + len())} · Duración ${Core.formatTime(len())}`, ev.clientX, ev.clientY);
      }
      T.scheduleRender();
    };
    const up = () => {
      contentEl.removeEventListener('pointermove', move);
      contentEl.removeEventListener('pointerup', up);
      tip(null);
      snapLine(null);
      if (moved) App.commit();
      else App.player.seek(t0);
    };
    contentEl.addEventListener('pointermove', move);
    contentEl.addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------------ transiciones
  function closePopover() {
    if (popover) { popover.remove(); popover = null; }
  }

  function openTransition(index, anchor) {
    closePopover();
    const c = state.clips[index];
    if (!c || !state.clips[index + 1]) return;
    const cur = c.transOut;
    const durLbl = h('span', { class: 'val changed' }, `${(cur ? cur.duration : 1).toFixed(1)} s`);
    const dur = h('input', { type: 'range', min: 0.2, max: 3, step: 0.1, value: cur ? cur.duration : 1 });
    paintRange(dur);
    dur.addEventListener('input', () => {
      durLbl.textContent = `${Number(dur.value).toFixed(1)} s`;
      if (c.transOut) { c.transOut.duration = Number(dur.value); T.scheduleRender(); App.player.refresh(); }
    });
    dur.addEventListener('change', () => { if (c.transOut) App.commit(); });
    popover = h('div', { class: 'popover' },
      h('h4', null, 'Transición'),
      h('div', { class: 'trans-grid' }, Core.TRANSITIONS.map((t) => h('button', {
        class: `chip${cur && cur.type === t.id ? ' on' : ''}`,
        onclick: () => {
          c.transOut = { type: t.id, duration: Number(dur.value) };
          App.commit();
          const it = App.player.sequence().items[index + 1];
          if (it) App.player.seek(Math.max(0, it.start - 0.3));
          openTransition(index, anchor);
        },
      }, t.label))),
      h('div', { class: 'slider' }, h('span', { class: 'lbl' }, 'Duración'), durLbl, dur),
      h('div', { class: 'btn-row' },
        cur ? h('button', { class: 'btn small', html: icon('trash'), onclick: () => { c.transOut = null; App.commit(); closePopover(); } }, 'Quitar') : null,
        h('button', { class: 'btn small', onclick: closePopover }, 'Cerrar')));
    document.body.appendChild(popover);
    const r = anchor.getBoundingClientRect();
    const ph = popover.offsetHeight;
    popover.style.left = `${clamp(r.left + r.width / 2 - 145, 8, innerWidth - 300)}px`;
    popover.style.top = `${clamp(r.top - ph - 10, 8, innerHeight - ph - 8)}px`;
  }
  T.openTransition = openTransition;

  // ------------------------------------------------------------------ init
  T.init = function () {
    scrollEl = $('#tl-scroll');
    bodyEl = $('#tl-body');
    contentEl = $('#tl-content');
    rowsEl = $('#tl-rows');
    headsEl = $('#tl-heads');
    ruler = $('#tl-ruler');
    rulerHeadEl = $('#tl-ruler-head');
    playheadEl = $('#tl-playhead');
    insertEl = $('#tl-insert');

    contentEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const tr = e.target.closest('[data-trans]');
      if (tr) { e.stopPropagation(); openTransition(Number(tr.dataset.trans), tr); return; }
      closePopover();
      contentEl.setPointerCapture(e.pointerId);
      if (App.player.mode !== 'sequence') App.player.setMode('sequence');
      const handle = e.target.closest('.clip-handle');
      const node = e.target.closest('.clip');
      if (!node) return startScrub(e);
      const { id, kind } = node.dataset;
      if (kind === 'video') return handle ? startVideoTrim(e, id, handle.dataset.side) : startVideoPress(e, id);
      startFree(e, kind, id, handle ? handle.dataset.side : null);
    });
    contentEl.addEventListener('contextmenu', (e) => {
      closePopover();
      if (App.player.playing) App.player.pause();
      if (App.player.mode !== 'sequence') App.player.setMode('sequence');
      const tr = e.target.closest('[data-trans]');
      if (tr) { e.preventDefault(); openTransition(Number(tr.dataset.trans), tr); return; }
      App.ctx.timelineMenu(e, timeAt);
    });
    document.addEventListener('pointerdown', (e) => { if (popover && !popover.contains(e.target) && !e.target.closest('[data-trans]')) closePopover(); });

    ruler.addEventListener('pointerdown', (e) => {
      ruler.setPointerCapture(e.pointerId);
      if (App.player.playing) App.player.pause();
      const go = (ev) => App.player.seek((ev.clientX - ruler.getBoundingClientRect().left + scrollEl.scrollLeft) / state.zoom);
      go(e);
      const up = () => { ruler.removeEventListener('pointermove', go); ruler.removeEventListener('pointerup', up); };
      ruler.addEventListener('pointermove', go);
      ruler.addEventListener('pointerup', up);
    });

    scrollEl.addEventListener('scroll', drawRuler);
    bodyEl.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const ax = e.clientX - scrollEl.getBoundingClientRect().left;
        T.setZoom(state.zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), ax);
      } else if (e.shiftKey || (bodyEl.scrollHeight <= bodyEl.clientHeight && Math.abs(e.deltaY) > Math.abs(e.deltaX))) {
        e.preventDefault();
        scrollEl.scrollLeft += e.deltaY || e.deltaX;
      }
    }, { passive: false });

    // Soltar desde la biblioteca o desde el explorador.
    const types = (e) => e.dataTransfer.types;
    const accepts = (e) => types(e).includes('application/x-fotograma-media') || types(e).includes('Files');
    const clearDrop = () => { $$('.tl-row.drop').forEach((r) => r.classList.remove('drop')); insertEl.hidden = true; };
    scrollEl.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      clearDrop();
      const isAudio = types(e).includes('application/x-fotograma-audio');
      const row = e.target.closest('.tl-row');
      if (isAudio || (row && row.dataset.row === 'audio' && types(e).includes('Files'))) {
        const r = row && row.dataset.row === 'audio' ? row : rowsEl.querySelector('.tl-row.audio');
        if (r) r.classList.add('drop');
      } else {
        rowsEl.querySelector('.tl-row.video').classList.add('drop');
        showInsert(insertIndexAt(timeAt(e.clientX)));
      }
    });
    scrollEl.addEventListener('dragleave', (e) => { if (!scrollEl.contains(e.relatedTarget)) clearDrop(); });
    scrollEl.addEventListener('drop', (e) => {
      e.preventDefault();
      clearDrop();
      const t = Math.max(0, timeAt(e.clientX));
      const row = e.target.closest('.tl-row');
      const trackId = row && row.dataset.track ? row.dataset.track : undefined;
      const index = insertIndexAt(t);
      const mid = e.dataTransfer.getData('application/x-fotograma-media');
      if (mid) return App.addClips([mid], index, { trackId, start: t });
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
      if (paths.length) App.library.importPaths(paths, { toTimeline: true, index, trackId, start: t });
    });

    $('#tl-zoom').addEventListener('input', (e) => T.setZoom(sliderToZoom(Number(e.target.value))));
    $('#tl-zoom-in').addEventListener('click', () => T.zoomBy(1.4));
    $('#tl-zoom-out').addEventListener('click', () => T.zoomBy(1 / 1.4));
    $('#tl-fit').addEventListener('click', T.fit);
    $('#tl-split').addEventListener('click', App.splitAtPlayhead);
    $('#tl-dup').addEventListener('click', () => App.duplicateSelected());
    $('#tl-del').addEventListener('click', () => App.removeSelected());
    $('#tl-add-text').addEventListener('click', App.addText);
    $('#tl-add-track').addEventListener('click', () => App.addTrack());
    $('#tl-snap').addEventListener('click', () => { state.snap = !state.snap; T.render(); });
    $('#tl-add-audio').addEventListener('click', async () => {
      const paths = await window.api.openMedia('audio');
      if (paths.length) App.library.importPaths(paths, { toTimeline: true, start: state.playhead });
    });

    new ResizeObserver(() => T.scheduleRender()).observe(scrollEl);
  };
})();
