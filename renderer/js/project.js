/* Guardar, abrir y crear proyectos (.fgproj). */
(function () {
  const App = window.App;
  const { state, store } = App;
  const Pr = (App.project = {});

  function data() {
    return {
      app: 'fotograma-studio',
      version: 1,
      settings: state.settings,
      media: state.mediaIds.map((id) => store.get(id)).filter((m) => m && m.info)
        .map((m) => ({ id: m.id, path: m.path, name: m.name, info: m.info })),
      clips: state.clips,
      audioClips: state.audioClips,
      textClips: state.textClips,
      tracks: state.tracks,
    };
  }

  Pr.save = async function (saveAs = false) {
    try {
      const p = await window.api.saveProject(data(), state.projectPath, saveAs);
      if (!p) return false;
      state.projectPath = p;
      App.setDirty(false);
      toast('Proyecto guardado', 'ok', 1800);
      return true;
    } catch (e) {
      toast(`No se pudo guardar: ${cleanIpcError(e.message)}`, 'err', 6000);
      return false;
    }
  };

  function reset() {
    App.player.pause();
    App.player.setCropEdit(false);
    store.clear();
    state.mediaIds = [];
    state.clips = [];
    state.audioClips = [];
    state.textClips = [];
    state.tracks = [App.newTrack('Audio 1')];
    state.selectedId = null;
    state.selectedMediaId = null;
    state.playhead = 0;
    App.player.setMode('sequence');
  }

  function load(d, path) {
    if (!d || d.app !== 'fotograma-studio') throw new Error('El archivo no es un proyecto de Fotograma Studio.');
    reset();
    for (const m of d.media || []) {
      // Proyectos de la versión 1: sin tipo de medio y con URL file://.
      m.info.kind = m.info.kind || 'video';
      m.info.url = `media://local/${encodeURIComponent(m.path)}`;
      store.set(m.id, { id: m.id, path: m.path, name: m.name, info: m.info });
      state.mediaIds.push(m.id);
    }
    state.clips = (d.clips || []).filter((c) => store.has(c.mediaId)).map((c) => ({
      ...Core.defaultClipProps(), ...c, color: { ...Core.defaultColor(), ...(c.color || {}) },
    }));
    if (d.tracks && d.tracks.length) state.tracks = d.tracks;
    state.audioClips = (d.audioClips || []).filter((a) => store.has(a.mediaId) && state.tracks.some((t) => t.id === a.trackId));
    state.textClips = (d.textClips || []).map((t) => ({ ...Core.defaultText(), ...t }));
    state.settings = { ...Core.defaultSettings(), ...(d.settings || {}) };
    state.projectPath = path;
    App.resetHistory();
    App.setDirty(false);
    App.syncCanvasControls();
    App.render();
    App.timeline.fit();

    const missing = [];
    Promise.all([...store.values()].map(async (m) => {
      const st = await window.api.stat(m.path);
      if (!st.exists) { m.missing = true; missing.push(m.name); return; }
      if (st.size !== m.info.size) {
        try { m.info = await window.api.probe(m.path); } catch { /* conserva la info guardada */ }
      }
      App.library.loadAssets(m);
    })).then(() => {
      App.library.render();
      if (missing.length) toast(`No se encuentran ${missing.length} archivo(s): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`, 'warn', 7000);
    });
  }

  Pr.open = async function () {
    if (state.dirty && !confirm('Hay cambios sin guardar. ¿Abrir otro proyecto igualmente?')) return;
    try {
      const r = await window.api.openProject();
      if (!r) return;
      load(r.data, r.path);
      toast('Proyecto abierto', 'ok', 1800);
    } catch (e) {
      toast(cleanIpcError(e.message), 'err', 6000);
    }
  };

  Pr.newProject = function () {
    if (state.dirty && !confirm('Hay cambios sin guardar. ¿Crear un proyecto nuevo igualmente?')) return;
    reset();
    state.settings = Core.defaultSettings();
    state.projectPath = null;
    App.resetHistory();
    App.setDirty(false);
    App.syncCanvasControls();
    App.render();
  };
})();
