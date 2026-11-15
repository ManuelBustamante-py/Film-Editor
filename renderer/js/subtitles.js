/* Subtítulos automáticos: se generan con Whisper (sin conexión) para cada archivo, se ven sobre el
   visor mientras editas, se corrigen en su pista de la línea de tiempo y se exportan grabados en
   el vídeo o en un .srt. Se guardan en el proyecto por medio y en tiempo del archivo original, así
   siguen a los clips al recortarlos, moverlos o cambiarles la velocidad. */
(function () {
  const App = window.App;
  const { state } = App;
  const S = (App.subs = {});
  const LANGS = [
    { id: 'es', label: 'Español' }, { id: 'en', label: 'Inglés' }, { id: 'pt', label: 'Portugués' },
    { id: 'fr', label: 'Francés' }, { id: 'it', label: 'Italiano' }, { id: 'de', label: 'Alemán' },
    { id: 'auto', label: 'Detectar automáticamente' },
  ];
  // Velocidad medida (veces el tiempo real) con 8 hilos: para estimar cuánto tardará.
  const SPEED = { precise: 2.3, fast: 5 };
  let layer, textEl, chip, ccBtn, redoBtn;
  let job = null;            // { id, mediaId, name, phase, pct, paused }
  let shownText = null;

  const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignorar */ } };
  S.visible = pref('fg.subsVisible', '1') === '1';

  S.of = (mediaId) => (state.subs[mediaId] && state.subs[mediaId].segments) || null;
  S.hasAny = () => state.clips.some((c) => (S.of(c.mediaId) || []).length);

  function find(segs, t) {
    let lo = 0, hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].e <= t) lo = mid + 1;
      else if (segs[mid].s > t) hi = mid - 1;
      else return segs[mid];
    }
    return null;
  }

  /** Subtítulos de la secuencia en tiempo de la línea de tiempo: [{ start, end, text, mediaId, k }]. */
  S.timelineCues = function () {
    const out = [];
    for (const it of App.player.sequence().items) {
      const c = it.clip, segs = S.of(c.mediaId);
      if (!segs) continue;
      segs.forEach((g, k) => {
        if (g.e <= c.in || g.s >= c.out) return;
        const start = it.start + (Math.max(g.s, c.in) - c.in) / c.speed;
        const end = Math.min(it.start + it.dur, it.start + (Math.min(g.e, c.out) - c.in) / c.speed);
        if (end - start > 0.02) out.push({ start, end, text: g.t, mediaId: c.mediaId, k });
      });
    }
    return out.sort((a, b) => a.start - b.start);
  };

  // ------------------------------------------------------------------ visor
  // Se llama en cada fotograma: solo toca el DOM cuando cambia el texto.
  S.render = function () {
    if (!layer) return;
    updateRedo();
    let text = '';
    if (S.visible) {
      const P = App.player;
      let mediaId = null, mt = 0;
      if (P.mode === 'source') {
        mediaId = P.sourceMediaId;
        mt = $('#layer-0 video').currentTime || 0;
      } else {
        const t = state.playhead;
        const loc = P.locate(t);
        if (loc && t < P.sequence().total) { mediaId = loc.item.clip.mediaId; mt = loc.item.clip.in + loc.local * loc.item.clip.speed; }
      }
      const segs = mediaId && S.of(mediaId);
      const g = segs && find(segs, mt);
      if (g) text = g.t;
    }
    if (text === shownText) return;
    shownText = text;
    textEl.textContent = text;
    layer.hidden = !text;
  };

  function updateRedo() { const m = currentMedia(), show = !!(m && S.of(m.id)); if (redoBtn.hidden === show) redoBtn.hidden = !show; redoBtn.disabled = !!job; }
  function updateCc() {
    if (!ccBtn) return;
    ccBtn.classList.toggle('on', S.visible);
    ccBtn.title = S.visible ? 'Ocultar subtítulos (C)' : 'Mostrar subtítulos (C)';
  }

  S.toggleVisible = function (v = !S.visible) {
    S.visible = v;
    setPref('fg.subsVisible', v ? '1' : '0');
    updateCc();
    shownText = null;
    S.render();
  };

  // El botón CC: si el clip del cabezal aún no tiene subtítulos, ofrece generarlos.
  function ccClick() {
    const m = currentMedia();
    if (m && !S.of(m.id) && !job) { S.generate(m.id); return; }
    S.toggleVisible();
  }

  function currentMedia() {
    const P = App.player;
    if (P.mode === 'source') return App.media(P.sourceMediaId);
    const sel = App.selectedClip();
    if (sel) return App.clipMedia(sel);
    const loc = P.locate(state.playhead);
    return loc ? App.clipMedia(loc.item.clip) : null;
  }

  // ------------------------------------------------------------------ generar
  const fmtMin = (sec) => (sec < 90 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`);

  S.generate = async function (mediaId) {
    const m = App.media(mediaId);
    if (!m || !m.info || !m.info.hasAudio) return toast('Este archivo no tiene audio', 'warn');
    if (job) return toast('Ya se están generando subtítulos; espera a que terminen.', 'warn');
    const st = await window.api.subsStatus();
    if (!st.available) return toast('Falta el motor de reconocimiento de voz. Reinstala la aplicación.', 'err', 6000);
    const prev = state.subs[mediaId];
    const o = { lang: prev ? prev.lang : pref('fg.subsLang', 'es'), track: prev ? prev.track : 0, quality: prev ? prev.quality : pref('fg.subsQuality', 'precise') };
    const tracks = m.info.audioTracks || [];
    const body = h('div', { class: 'subs-form' });
    const go = h('button', { class: 'btn accent' }, prev ? 'Volver a generar' : 'Generar');
    const dlg = modal({ title: 'Generar subtítulos', body, foot: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancelar'), go], narrow: true });
    const render = () => {
      body.innerHTML = '';
      body.appendChild(h('p', { class: 'muted' }, h('b', null, m.name), ` · ${Core.formatTime(m.info.duration, 0)}`));
      const lang = h('select', null, ...LANGS.map((l) => h('option', { value: l.id, selected: l.id === o.lang }, l.label)));
      lang.addEventListener('change', () => { o.lang = lang.value; });
      body.appendChild(h('label', { class: 'field' }, h('span', null, 'Idioma de lo que se habla'), lang));
      if (tracks.length > 1) {
        const tr = h('select', null, ...tracks.map((t) => h('option', { value: t.i, selected: t.i === o.track }, `${t.i + 1}. ${t.name}`)));
        tr.addEventListener('change', () => { o.track = Number(tr.value); });
        body.appendChild(h('label', { class: 'field' }, h('span', null, 'Pista de audio'), tr));
        body.appendChild(h('div', { class: 'hint' }, 'Elige la pista donde mejor se oyen las voces (la del juego, el micrófono o el chat de voz). La música de fondo empeora el resultado.'));
      }
      const q = h('div', { class: 'seg' },
        ...[['precise', 'Precisa'], ['fast', 'Rápida']].map(([id, label]) => h('button', { class: o.quality === id ? 'on' : '', onclick: () => { o.quality = id; render(); } }, label)));
      body.appendChild(h('label', { class: 'field' }, h('span', null, 'Calidad'), q));
      const need = !st.models[o.quality];
      const mb = Math.round(st.sizes[o.quality] / 1048576);
      body.appendChild(h('div', { class: 'hint' },
        `Tardará unos ${fmtMin(m.info.duration / SPEED[o.quality])} en segundo plano (se pausa mientras reproduces).`,
        need ? ` La primera vez se descarga el modelo de voz (${mb} MB).` : '',
        ' Todo se procesa en tu PC: el audio no se envía a internet.'));
      if (prev) body.appendChild(h('div', { class: 'warnbox', html: icon('alert') }, h('span', null, 'Se reemplazarán los subtítulos actuales de este archivo, incluidas tus correcciones.')));
    };
    render();
    go.addEventListener('click', () => { dlg.close(); start(m, o); });
  };

  async function start(m, o) {
    setPref('fg.subsLang', o.lang);
    setPref('fg.subsQuality', o.quality);
    const id = `subs:${m.id}:${Date.now()}`;
    job = { id, mediaId: m.id, name: m.name, phase: 'download', pct: 0, paused: false };
    updateChip();
    const off = window.api.onJobProgress((d) => {
      if (!job || d.id !== id) return;
      job.phase = d.phase || job.phase;
      job.pct = d.pct || 0;
      job.paused = !!d.paused;
      updateChip();
    });
    const r = await window.api.transcribe({ id, file: m.path, track: o.track, lang: o.lang, quality: o.quality, duration: m.info.duration });
    off();
    job = null;
    updateChip();
    if (!r.ok) {
      if (!r.cancelled) toast(`No se pudieron generar los subtítulos: ${cleanIpcError(r.error || '')}`, 'err', 7000);
      return;
    }
    if (!App.media(m.id)) return;
    state.subs[m.id] = { track: o.track, lang: o.lang, quality: o.quality, segments: r.segments };
    App.commit();
    if (!S.visible) S.toggleVisible(true);
    shownText = null;
    toast(r.segments.length ? `${r.segments.length} subtítulos generados para ${m.name}` : `No se detectó habla en ${m.name}`, r.segments.length ? 'ok' : 'warn', 4000);
  }

  function updateChip() {
    if (!chip) return;
    chip.hidden = !job;
    if (!job) return;
    const pct = Math.round(job.pct * 100);
    const what = job.phase === 'download' ? 'Descargando modelo de voz' : job.phase === 'audio' ? 'Preparando audio' : 'Generando subtítulos';
    chip.querySelector('span').textContent = `${what}… ${pct}%${job.paused && job.phase === 'transcribe' ? ' · en pausa mientras reproduces' : ''}`;
  }
  S.onPlayback = updateChip;

  // ------------------------------------------------------------------ edición
  S.editText = function (mediaId, k, text) {
    const segs = S.of(mediaId);
    if (!segs || !segs[k]) return;
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (!t) segs.splice(k, 1);
    else segs[k].t = t;
    shownText = null;
    App.commit();
  };
  S.remove = function (mediaId, k) { S.editText(mediaId, k, ''); };
  S.clear = function (mediaId) {
    if (!state.subs[mediaId]) return;
    delete state.subs[mediaId];
    shownText = null;
    App.commit();
  };

  // Edición en línea sobre el bloque de la línea de tiempo.
  S.startEdit = function (node, mediaId, k) {
    const segs = S.of(mediaId);
    if (!segs || !segs[k]) return;
    if (App.player.playing) App.player.pause();
    const inp = h('textarea', { class: 'sub-edit', rows: 2 });
    inp.value = segs[k].t;
    node.classList.add('editing');
    node.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && inp.value.trim() !== segs[k].t) S.editText(mediaId, k, inp.value);
      else App.timeline.render();
    };
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  };

  S.menu = function (e, mediaId, k) {
    const m = App.media(mediaId);
    contextMenu(e, [
      { header: 'Subtítulo' },
      { label: 'Editar texto', icon: 'type', action: () => { const n = document.querySelector(`.tl-sub[data-m="${mediaId}"][data-k="${k}"]`); if (n) S.startEdit(n, mediaId, k); } },
      { label: 'Eliminar este subtítulo', icon: 'trash', action: () => S.remove(mediaId, k) },
      'sep',
      { label: S.visible ? 'Ocultar en el visor' : 'Mostrar en el visor', icon: 'eye', action: () => S.toggleVisible() },
      { label: 'Volver a generar…', icon: 'reset', disabled: !!job, action: () => S.generate(mediaId) },
      { label: `Quitar todos los de ${m ? m.name : 'este archivo'}`, icon: 'trash', danger: true, action: () => S.clear(mediaId) },
    ]);
  };

  // ------------------------------------------------------------------ init
  S.init = function () {
    layer = $('#subs-layer');
    textEl = layer.querySelector('span');
    chip = $('#subs-status');
    ccBtn = $('#btn-cc');
    ccBtn.addEventListener('click', ccClick); redoBtn = $('#btn-cc-redo'); redoBtn.addEventListener('click', () => { const m = currentMedia(); if (m) S.generate(m.id); });
    chip.querySelector('button').addEventListener('click', () => { if (job) window.api.cancelJob(job.id); });
    // El tamaño de letra sigue al del visor, como quedará al grabarlos en el vídeo.
    const stage = $('#stage');
    new ResizeObserver(() => { layer.style.fontSize = `${Math.max(11, stage.clientHeight * 0.052)}px`; }).observe(stage);
    updateCc();
    updateChip();
  };
})();
