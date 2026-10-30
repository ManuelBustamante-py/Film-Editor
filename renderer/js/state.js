/* Estado del proyecto, historial y operaciones sobre clips (vídeo, audio y texto). */
(function () {
  const App = (window.App = window.App || {});

  const state = (App.state = {
    mediaIds: [],        // orden de la biblioteca
    clips: [],           // pista de vídeo (secuencia magnética)
    audioClips: [],      // clips de audio con posición libre
    textClips: [],       // textos superpuestos
    tracks: [],          // pistas de audio
    selectedId: null,    // elemento seleccionado
    selKind: 'video',    // 'video' | 'audio' | 'text'
    selectedMediaId: null,
    playhead: 0,
    zoom: 60,
    snap: true,
    settings: Core.defaultSettings(),
    projectPath: null,
    dirty: false,
    caps: null,
  });

  // Los medios viven en un almacén aparte: el historial solo guarda sus ids,
  // así las miniaturas que llegan de forma asíncrona no se pierden al deshacer.
  const store = (App.store = new Map());
  App.media = (id) => store.get(id);
  App.clip = (id) => state.clips.find((c) => c.id === id);
  App.audioClip = (id) => state.audioClips.find((c) => c.id === id);
  App.textClip = (id) => state.textClips.find((c) => c.id === id);
  App.track = (id) => state.tracks.find((t) => t.id === id);
  App.selectedClip = () => (state.selKind === 'video' ? App.clip(state.selectedId) : null);
  App.selectedAudio = () => (state.selKind === 'audio' ? App.audioClip(state.selectedId) : null);
  App.selectedText = () => (state.selKind === 'text' ? App.textClip(state.selectedId) : null);
  App.clipMedia = (c) => c && store.get(c.mediaId);

  App.newTrack = (name) => ({ id: uid('t'), name: name || `Audio ${state.tracks.length + 1}`, muted: false, solo: false, volume: 1 });
  state.tracks.push(App.newTrack('Audio 1'));

  // ------------------------------------------------------------------ historial
  const hist = { stack: [], index: -1 };
  const snap = () => JSON.stringify({
    mediaIds: state.mediaIds, clips: state.clips, audioClips: state.audioClips, textClips: state.textClips,
    tracks: state.tracks, selectedId: state.selectedId, selKind: state.selKind,
  });

  function restore(s) {
    Object.assign(state, JSON.parse(s));
    App.setDirty(true);
    App.render();
  }

  App.commit = function () {
    hist.stack = hist.stack.slice(0, hist.index + 1);
    hist.stack.push(snap());
    if (hist.stack.length > 300) hist.stack.shift();
    hist.index = hist.stack.length - 1;
    App.setDirty(true);
    App.render();
  };
  App.resetHistory = function () {
    hist.stack = [snap()];
    hist.index = 0;
    updateHistoryButtons();
  };
  App.undo = function () {
    if (hist.index <= 0) return;
    hist.index--;
    restore(hist.stack[hist.index]);
  };
  App.redo = function () {
    if (hist.index >= hist.stack.length - 1) return;
    hist.index++;
    restore(hist.stack[hist.index]);
  };
  function updateHistoryButtons() {
    $('#btn-undo').disabled = hist.index <= 0;
    $('#btn-redo').disabled = hist.index >= hist.stack.length - 1;
  }

  App.setDirty = function (d) {
    state.dirty = d;
    window.api.setDirty(d);
    updateTitle();
  };
  function updateTitle() {
    const name = state.projectPath ? stripExt(baseName(state.projectPath)) : 'Proyecto sin título';
    const el = $('#project-name');
    el.textContent = name;
    el.classList.toggle('dirty', state.dirty);
    document.title = `${name}${state.dirty ? ' •' : ''} — Fotograma Studio`;
  }

  // ------------------------------------------------------------------ render
  App.render = function () {
    App.library.render();
    App.timeline.render();
    App.inspector.render();
    App.player.refresh();
    updateHistoryButtons();
    updateTitle();
  };
  // Cambios continuos (deslizadores): sin reconstruir el inspector.
  App.renderLive = function () {
    App.timeline.scheduleRender();
    App.player.refreshLook();
  };

  // Fin de todo el contenido (vídeo, audio y textos).
  App.contentEnd = function () {
    let end = Core.sequenceLayout(state.clips).total;
    for (const a of state.audioClips) end = Math.max(end, a.start + a.out - a.in);
    for (const t of state.textClips) end = Math.max(end, t.start + t.duration);
    return end;
  };

  // ------------------------------------------------------------------ creación
  App.createClip = function (media, inT = 0, outT = null) {
    return { id: uid('c'), mediaId: media.id, in: inT, out: outT == null ? media.info.duration : outT, ...Core.defaultClipProps() };
  };

  function freeStart(trackId, desired, len) {
    // Si el hueco está ocupado, coloca el clip tras el último que se solape.
    const others = state.audioClips.filter((a) => a.trackId === trackId).sort((a, b) => a.start - b.start);
    let s = desired;
    for (const o of others) {
      const oe = o.start + o.out - o.in;
      if (s < oe && s + len > o.start) s = oe;
    }
    return s;
  }

  App.createAudioClip = function (media, { trackId, start } = {}) {
    if (!state.tracks.length) state.tracks.push(App.newTrack());
    const tid = trackId && App.track(trackId) ? trackId : state.tracks[0].id;
    const len = media.info.duration;
    return {
      id: uid('a'), mediaId: media.id, trackId: tid, start: freeStart(tid, Math.max(0, start ?? state.playhead), len),
      in: 0, out: len, volume: 1, fadeIn: 0, fadeOut: 0, muted: false,
    };
  };

  // Añade medios: los vídeos a la pista de vídeo y los audios a una pista de audio.
  App.addClips = function (mediaIds, index = state.clips.length, opts = {}) {
    const medias = mediaIds.map((id) => store.get(id)).filter((m) => m && m.info && !m.missing);
    const vids = medias.filter((m) => m.info.kind !== 'audio').map((m) => App.createClip(m));
    const auds = [];
    let start = opts.start ?? state.playhead;
    for (const m of medias.filter((x) => x.info.kind === 'audio')) {
      const a = App.createAudioClip(m, { trackId: opts.trackId, start });
      auds.push(a);
      state.audioClips.push(a);
      start = a.start + a.out - a.in;
    }
    if (vids.length) state.clips.splice(index, 0, ...vids);
    const last = auds.length ? auds[auds.length - 1] : vids[vids.length - 1];
    if (!last) return;
    state.selectedId = last.id;
    state.selKind = auds.length ? 'audio' : 'video';
    App.commit();
    const n = vids.length + auds.length;
    toast(n === 1 ? 'Añadido a la línea de tiempo' : `${n} elementos añadidos a la línea de tiempo`, 'ok', 2000);
  };

  App.addText = function () {
    const t = { id: uid('x'), ...Core.defaultText(), start: state.playhead };
    state.textClips.push(t);
    state.selectedId = t.id;
    state.selKind = 'text';
    App.commit();
  };

  App.addTrack = function () {
    const t = App.newTrack();
    state.tracks.push(t);
    App.commit();
    return t;
  };

  App.removeTrack = function (id) {
    const used = state.audioClips.filter((a) => a.trackId === id).length;
    if (used && !confirm(`La pista contiene ${used} clip(s). ¿Eliminarla con su contenido?`)) return;
    state.tracks = state.tracks.filter((t) => t.id !== id);
    state.audioClips = state.audioClips.filter((a) => a.trackId !== id);
    App.commit();
  };

  // ------------------------------------------------------------------ selección
  App.select = function (id, { kind = 'video', seek = false } = {}) {
    const changed = state.selectedId !== id || state.selKind !== kind;
    state.selectedId = id;
    state.selKind = kind;
    if (seek && id && kind === 'video') {
      const it = App.player.sequence().items.find((i) => i.clip.id === id);
      if (it && (state.playhead < it.start || state.playhead >= it.start + it.dur)) App.player.seek(it.start);
    }
    if (changed) {
      App.timeline.render();
      App.inspector.render();
      App.player.refresh();
    }
  };

  // ------------------------------------------------------------------ edición
  App.removeSelected = function () {
    const id = state.selectedId;
    if (!id) return;
    if (state.selKind === 'audio') state.audioClips = state.audioClips.filter((a) => a.id !== id);
    else if (state.selKind === 'text') state.textClips = state.textClips.filter((t) => t.id !== id);
    else {
      const i = state.clips.findIndex((c) => c.id === id);
      if (i < 0) return;
      state.clips.splice(i, 1);
      const next = state.clips[i] || state.clips[i - 1];
      state.selectedId = next ? next.id : null;
      App.commit();
      return;
    }
    state.selectedId = null;
    App.commit();
  };
  App.removeClip = App.removeSelected;

  App.duplicateSelected = function () {
    const id = state.selectedId;
    if (!id) return;
    if (state.selKind === 'video') {
      const i = state.clips.findIndex((c) => c.id === id);
      if (i < 0) return;
      const copy = JSON.parse(JSON.stringify(state.clips[i]));
      copy.id = uid('c');
      state.clips.splice(i + 1, 0, copy);
      state.selectedId = copy.id;
    } else if (state.selKind === 'audio') {
      const a = App.audioClip(id);
      const copy = { ...JSON.parse(JSON.stringify(a)), id: uid('a') };
      copy.start = freeStart(a.trackId, a.start + a.out - a.in, a.out - a.in);
      state.audioClips.push(copy);
      state.selectedId = copy.id;
    } else {
      const t = App.textClip(id);
      const copy = { ...JSON.parse(JSON.stringify(t)), id: uid('x'), start: t.start + t.duration };
      state.textClips.push(copy);
      state.selectedId = copy.id;
    }
    App.commit();
  };
  App.duplicateClip = App.duplicateSelected;

  // Divide el elemento seleccionado (audio/texto) o el clip de vídeo bajo el cabezal.
  App.splitAtPlayhead = function () {
    const t = state.playhead;
    const a = App.selectedAudio();
    if (a && t > a.start + 0.05 && t < a.start + a.out - a.in - 0.05) {
      const b = { ...JSON.parse(JSON.stringify(a)), id: uid('a') };
      const cut = a.in + (t - a.start);
      a.out = cut;
      a.fadeOut = 0;
      b.in = cut;
      b.start = t;
      b.fadeIn = 0;
      state.audioClips.push(b);
      state.selectedId = b.id;
      return App.commit();
    }
    const x = App.selectedText();
    if (x && t > x.start + 0.05 && t < x.start + x.duration - 0.05) {
      const b = { ...JSON.parse(JSON.stringify(x)), id: uid('x') };
      b.start = t;
      b.duration = x.start + x.duration - t;
      x.duration = t - x.start;
      state.textClips.push(b);
      state.selectedId = b.id;
      return App.commit();
    }
    const loc = App.player.locate(t);
    if (!loc) return toast('No hay ningún clip bajo el cabezal', 'warn');
    const c = state.clips[loc.i];
    const st = c.in + loc.local * c.speed;
    if (st - c.in < 0.05 || c.out - st < 0.05) return toast('Mueve el cabezal dentro del clip para dividirlo', 'warn');
    const b = JSON.parse(JSON.stringify(c));
    b.id = uid('c');
    b.in = st;
    b.fadeIn = 0;
    c.out = st;
    c.fadeOut = 0;
    c.transOut = null;
    state.clips.splice(loc.i + 1, 0, b);
    state.selectedId = b.id;
    state.selKind = 'video';
    App.commit();
  };

  // Marca la entrada/salida del clip de vídeo bajo el cabezal.
  App.markAtPlayhead = function (which) {
    const loc = App.player.locate(state.playhead);
    if (!loc) return;
    const c = state.clips[loc.i];
    const t = c.in + loc.local * c.speed;
    const it = App.player.sequence().items[loc.i];
    if (which === 'in') {
      if (c.out - t < 0.05) return toast('La entrada debe quedar antes de la salida', 'warn');
      c.in = t;
      state.selectedId = c.id;
      state.selKind = 'video';
      App.commit();
      App.player.seek(it.start);
    } else {
      if (t - c.in < 0.05) return toast('La salida debe quedar después de la entrada', 'warn');
      c.out = t;
      state.selectedId = c.id;
      state.selKind = 'video';
      App.commit();
    }
  };

  App.moveClip = function (fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex + 1 === toIndex) return;
    const [c] = state.clips.splice(fromIndex, 1);
    state.clips.splice(toIndex > fromIndex ? toIndex - 1 : toIndex, 0, c);
    App.commit();
  };

  App.removeMedia = function (mediaId) {
    const used = state.clips.filter((c) => c.mediaId === mediaId).length + state.audioClips.filter((a) => a.mediaId === mediaId).length;
    if (used && !confirm(`Este archivo se usa en ${used} clip(s) de la línea de tiempo. ¿Quitarlo también de allí?`)) return;
    state.mediaIds = state.mediaIds.filter((id) => id !== mediaId);
    state.clips = state.clips.filter((c) => c.mediaId !== mediaId);
    state.audioClips = state.audioClips.filter((a) => a.mediaId !== mediaId);
    if (state.selectedMediaId === mediaId) {
      state.selectedMediaId = null;
      App.player.setMode('sequence');
    }
    App.commit();
  };

  // ------------------------------------------------------------------ datos para el motor
  App.jobClips = function (clips = state.clips) {
    return clips.map((c) => {
      const m = store.get(c.mediaId);
      const i = m.info;
      return {
        path: m.path, srcW: i.width, srcH: i.height, srcFps: i.fps, srcFpsStr: i.fpsStr,
        srcDuration: i.duration, srcSize: i.size, sar: i.sar, hasAudio: i.hasAudio,
        in: c.in, out: c.out, speed: c.speed, volume: c.volume, muted: c.muted,
        fadeIn: c.fadeIn, fadeOut: c.fadeOut, rotate: c.rotate, flipH: c.flipH, flipV: c.flipV,
        crop: c.crop, color: c.color, transOut: c.transOut,
      };
    });
  };

  // Ganancia efectiva de un clip de audio teniendo en cuenta silencio y solo de pistas.
  App.audioGain = function (a) {
    const t = App.track(a.trackId);
    if (!t || a.muted || t.muted) return 0;
    if (state.tracks.some((x) => x.solo) && !t.solo) return 0;
    return a.volume * t.volume;
  };

  App.jobAudios = function () {
    return state.audioClips.map((a) => ({ a, g: App.audioGain(a) })).filter((x) => x.g > 0).map(({ a, g }) => ({
      path: store.get(a.mediaId).path, start: a.start, in: a.in, out: a.out, volume: g, fadeIn: a.fadeIn, fadeOut: a.fadeOut,
    }));
  };

  // Renderiza los textos a PNG con la resolución final de la exportación.
  App.jobTexts = async function (plan) {
    const out = [];
    for (const t of state.textClips) {
      if (t.start >= plan.duration - 0.01 || !t.text.trim()) continue;
      const duration = Math.min(t.duration, plan.duration - t.start);
      out.push({ png: await App.text.renderPng(t, plan.width, plan.height), start: t.start, duration, fadeIn: t.fadeIn, fadeOut: t.fadeOut });
    }
    return out;
  };

  App.plan = () => Core.planOutput(App.jobClips(), state.settings);
})();
