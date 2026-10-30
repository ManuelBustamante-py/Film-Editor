/* Menús contextuales (clic derecho) de la línea de tiempo y la biblioteca. */
(function () {
  const App = window.App;
  const { state } = App;
  const C = (App.ctx = {});
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  let clipboard = null; // ajustes copiados de un clip de vídeo

  // ------------------------------------------------------------------ acciones
  const ATTRS = ['speed', 'color', 'rotate', 'flipH', 'flipV', 'crop', 'volume', 'muted', 'fadeIn', 'fadeOut'];

  C.copyAttrs = function (c = App.selectedClip()) {
    if (!c) return toast('Selecciona un clip de vídeo para copiar sus ajustes', 'warn');
    clipboard = JSON.parse(JSON.stringify(Object.fromEntries(ATTRS.map((k) => [k, c[k]]))));
    toast('Ajustes del clip copiados', 'info', 1500);
  };

  C.pasteAttrs = function (c = App.selectedClip()) {
    if (!clipboard) return toast('No hay ajustes copiados', 'warn');
    if (!c) return toast('Selecciona un clip de vídeo para pegar los ajustes', 'warn');
    Object.assign(c, JSON.parse(JSON.stringify(clipboard)));
    App.commit();
    toast('Ajustes pegados', 'ok', 1500);
  };

  // Pista de audio libre en el intervalo [start, end); si no hay, crea una nueva.
  function freeTrack(start, end, preferId) {
    const free = (t) => !state.audioClips.some((a) => a.trackId === t.id && a.start < end && a.start + a.out - a.in > start);
    const pref = App.track(preferId);
    if (pref && free(pref)) return pref;
    return state.tracks.find(free) || (() => { const t = App.newTrack(); state.tracks.push(t); return t; })();
  }

  // Pasa el audio del clip de vídeo a una pista de audio independiente.
  C.detachAudio = function (c) {
    const m = App.clipMedia(c);
    if (!m.info.hasAudio) return;
    const it = App.player.sequence().items.find((i) => i.clip.id === c.id);
    const track = freeTrack(it.start, it.start + it.dur);
    const a = {
      id: uid('a'), mediaId: c.mediaId, trackId: track.id, start: it.start, in: c.in, out: c.out,
      volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, muted: false,
    };
    state.audioClips.push(a);
    c.muted = true;
    state.selectedId = a.id;
    state.selKind = 'audio';
    App.commit();
    toast(`Audio separado en «${track.name}». El clip de vídeo queda silenciado.`, 'ok', 3000);
  };

  function showInFolder(m) {
    if (m) window.api.showItem(m.path);
  }

  function openStudio(m) {
    App.showView('studio');
    App.studio.load(m.path);
  }

  function openCutter(m) {
    App.showView('cutter');
    App.cutter.load(m.path);
  }

  function playheadIn(start, dur) {
    return state.playhead > start + 0.05 && state.playhead < start + dur - 0.05;
  }

  // ------------------------------------------------------------------ menús
  function videoMenu(c) {
    const m = App.clipMedia(c);
    const seq = App.player.sequence();
    const it = seq.items.find((i) => i.clip.id === c.id);
    const idx = state.clips.indexOf(c);
    const last = idx === state.clips.length - 1;
    const set = (fn) => () => { fn(); App.commit(); };
    return [
      { header: m.name },
      { label: 'Dividir en el cabezal', icon: 'scissors', shortcut: 'S', disabled: !playheadIn(it.start, it.dur), action: App.splitAtPlayhead },
      { label: 'Duplicar', icon: 'copy', shortcut: 'Ctrl+D', action: () => App.duplicateSelected() },
      'sep',
      { label: 'Velocidad', icon: 'speed', submenu: SPEEDS.map((s) => ({ label: `${s}×`, checked: Math.abs(c.speed - s) < 1e-3, action: set(() => { c.speed = s; }) })) },
      { label: 'Transición al siguiente', icon: 'transition', disabled: last, submenu: [
        { label: 'Corte directo', checked: !c.transOut, action: set(() => { c.transOut = null; }) },
        'sep',
        ...Core.TRANSITIONS.map((t) => ({ label: t.label, checked: !!c.transOut && c.transOut.type === t.id,
          action: set(() => { c.transOut = { type: t.id, duration: c.transOut ? c.transOut.duration : 1 }; }) })),
      ] },
      { label: 'Filtro de color', icon: 'palette', submenu: [
        ...Core.COLOR_PRESETS.map((p) => ({ label: p.label, checked: c.color.preset === p.id, action: set(() => { c.color.preset = p.id; c.color.intensity = 100; }) })),
        'sep',
        { label: 'Restablecer todo el color', icon: 'reset', disabled: Core.isDefaultColor(c.color), action: set(() => { c.color = Core.defaultColor(); }) },
      ] },
      { label: 'Girar y voltear', icon: 'rotateCw', submenu: [
        { label: 'Girar 90° a la derecha', icon: 'rotateCw', action: set(() => { c.rotate = (c.rotate + 90) % 360; c.crop = null; }) },
        { label: 'Girar 90° a la izquierda', icon: 'rotateCcw', action: set(() => { c.rotate = (c.rotate + 270) % 360; c.crop = null; }) },
        { label: 'Voltear horizontal', icon: 'flipH', checked: c.flipH, action: set(() => { c.flipH = !c.flipH; }) },
        { label: 'Voltear vertical', icon: 'flipV', checked: c.flipV, action: set(() => { c.flipV = !c.flipV; }) },
        'sep',
        { label: 'Editar encuadre…', icon: 'crop', action: () => { App.select(c.id, { kind: 'video' }); App.player.setCropEdit(true); } },
        { label: 'Quitar encuadre', icon: 'reset', disabled: !c.crop, action: set(() => { c.crop = null; }) },
      ] },
      'sep',
      m.info.hasAudio ? { label: c.muted ? 'Activar audio' : 'Silenciar audio', icon: c.muted ? 'volume' : 'mute', action: set(() => { c.muted = !c.muted; }) } : null,
      { label: 'Separar audio a una pista', icon: 'music', disabled: !m.info.hasAudio || c.muted || Math.abs(c.speed - 1) > 1e-3,
        title: Math.abs(c.speed - 1) > 1e-3 ? 'Solo disponible con velocidad 1×' : '', action: () => C.detachAudio(c) },
      { label: 'Abrir audio en Audio Studio', icon: 'wave', disabled: !m.info.hasAudio, action: () => openStudio(m) },
      'sep',
      { label: 'Copiar ajustes', icon: 'copy', shortcut: 'Ctrl+Mayús+C', action: () => C.copyAttrs(c) },
      { label: 'Pegar ajustes', icon: 'layers', shortcut: 'Ctrl+Mayús+V', disabled: !clipboard, action: () => C.pasteAttrs(c) },
      { label: 'Restablecer recorte', icon: 'trim', disabled: c.in < 0.001 && c.out > m.info.duration - 0.001, action: set(() => { c.in = 0; c.out = m.info.duration; }) },
      { label: 'Mover', icon: 'frameFwd', submenu: [
        { label: 'Al principio', disabled: idx === 0, action: () => App.moveClip(idx, 0) },
        { label: 'Un puesto antes', disabled: idx === 0, action: () => App.moveClip(idx, idx - 1) },
        { label: 'Un puesto después', disabled: last, action: () => App.moveClip(idx, idx + 2) },
        { label: 'Al final', disabled: last, action: () => App.moveClip(idx, state.clips.length) },
      ] },
      'sep',
      { label: 'Mostrar archivo en la carpeta', icon: 'folder', action: () => showInFolder(m) },
      { label: 'Eliminar', icon: 'trash', shortcut: 'Supr', danger: true, action: () => App.removeSelected() },
    ];
  }

  function audioMenu(a) {
    const m = App.media(a.mediaId);
    const len = a.out - a.in;
    const set = (fn) => () => { fn(); App.commit(); };
    return [
      { header: m.info.title || m.name },
      { label: 'Dividir en el cabezal', icon: 'scissors', shortcut: 'S', disabled: !playheadIn(a.start, len), action: App.splitAtPlayhead },
      { label: 'Duplicar', icon: 'copy', shortcut: 'Ctrl+D', action: () => App.duplicateSelected() },
      'sep',
      { label: 'Mover al cabezal', icon: 'frameFwd', action: set(() => { a.start = state.playhead; }) },
      { label: 'Mover a la pista', icon: 'layers', submenu: [
        ...state.tracks.map((t) => ({ label: t.name, checked: t.id === a.trackId, action: set(() => { a.trackId = t.id; }) })),
        'sep',
        { label: 'Nueva pista', icon: 'plus', action: set(() => { const t = App.newTrack(); state.tracks.push(t); a.trackId = t.id; }) },
      ] },
      { label: 'Volumen', icon: 'volume', submenu: [25, 50, 75, 100, 125, 150, 200].map((v) => ({
        label: `${v}%`, checked: Math.round(a.volume * 100) === v, action: set(() => { a.volume = v / 100; }) })) },
      { label: 'Fundidos', icon: 'fade', submenu: [
        { label: 'Entrada 1 s', action: set(() => { a.fadeIn = Math.min(1, len / 2); }) },
        { label: 'Salida 2 s', action: set(() => { a.fadeOut = Math.min(2, len / 2); }) },
        { label: 'Entrada y salida', action: set(() => { a.fadeIn = Math.min(1, len / 2); a.fadeOut = Math.min(2, len / 2); }) },
        'sep',
        { label: 'Quitar fundidos', icon: 'reset', disabled: !a.fadeIn && !a.fadeOut, action: set(() => { a.fadeIn = 0; a.fadeOut = 0; }) },
      ] },
      { label: a.muted ? 'Activar' : 'Silenciar', icon: a.muted ? 'volume' : 'mute', action: set(() => { a.muted = !a.muted; }) },
      { label: 'Restablecer recorte', icon: 'trim', disabled: a.in < 0.001 && a.out > m.info.duration - 0.001, action: set(() => { a.in = 0; a.out = m.info.duration; }) },
      'sep',
      { label: 'Abrir en Audio Studio', icon: 'wave', action: () => openStudio(m) },
      { label: 'Abrir en el Cortador', icon: 'scissors', action: () => openCutter(m) },
      { label: 'Mostrar archivo en la carpeta', icon: 'folder', action: () => showInFolder(m) },
      'sep',
      { label: 'Eliminar', icon: 'trash', shortcut: 'Supr', danger: true, action: () => App.removeSelected() },
    ];
  }

  function textMenu(t) {
    const set = (fn) => () => { fn(); App.commit(); };
    const under = App.player.locate(state.playhead);
    return [
      { header: t.text.split('\n')[0] || 'Texto' },
      { label: 'Dividir en el cabezal', icon: 'scissors', shortcut: 'S', disabled: !playheadIn(t.start, t.duration), action: App.splitAtPlayhead },
      { label: 'Duplicar', icon: 'copy', shortcut: 'Ctrl+D', action: () => App.duplicateSelected() },
      'sep',
      { label: 'Mover al cabezal', icon: 'frameFwd', action: set(() => { t.start = state.playhead; }) },
      { label: 'Ajustar al clip bajo el cabezal', icon: 'fit', disabled: !under,
        action: set(() => { t.start = under.item.start; t.duration = under.item.dur; }) },
      { label: 'Posición', icon: 'transform', submenu: [
        { label: 'Arriba', action: set(() => { t.x = 0.5; t.y = 0.15; }) },
        { label: 'Centro', action: set(() => { t.x = 0.5; t.y = 0.5; }) },
        { label: 'Abajo', action: set(() => { t.x = 0.5; t.y = 0.82; }) },
      ] },
      { label: 'Fondo', icon: 'image', checked: t.box, action: set(() => { t.box = !t.box; }) },
      { label: 'Negrita', icon: 'bold', checked: t.bold, action: set(() => { t.bold = !t.bold; }) },
      { label: 'Sombra', icon: 'sparkle', checked: t.shadow, action: set(() => { t.shadow = !t.shadow; }) },
      'sep',
      { label: 'Eliminar', icon: 'trash', shortcut: 'Supr', danger: true, action: () => App.removeSelected() },
    ];
  }

  function emptyMenu(row, time) {
    const goHere = { label: 'Mover el cabezal aquí', icon: 'frameFwd', action: () => App.player.seek(time) };
    const common = ['sep', goHere, { label: 'Ajustar zoom a todo', icon: 'fit', action: App.timeline.fit }];
    if (row && row.dataset.row === 'text') {
      return [
        { label: 'Añadir texto aquí', icon: 'type', action: () => { state.playhead = time; App.addText(); App.player.seek(time); } },
        ...common,
      ];
    }
    if (row && row.dataset.row === 'audio') {
      const t = App.track(row.dataset.track);
      return [
        { header: t ? t.name : 'Pista de audio' },
        { label: 'Importar música aquí…', icon: 'music', action: async () => {
          const paths = await window.api.openMedia('audio');
          if (paths.length) App.library.importPaths(paths, { toTimeline: true, trackId: t && t.id, start: time });
        } },
        { label: 'Nueva pista de audio', icon: 'plus', action: () => App.addTrack() },
        t ? 'sep' : null,
        t ? { label: 'Silenciar pista', icon: 'mute', checked: t.muted, action: () => { t.muted = !t.muted; App.commit(); } } : null,
        t ? { label: 'Solo', icon: 'headphones', checked: t.solo, action: () => { t.solo = !t.solo; App.commit(); } } : null,
        t ? { label: 'Eliminar pista', icon: 'trash', danger: true, action: () => App.removeTrack(t.id) } : null,
        ...common,
      ];
    }
    return [
      { label: 'Importar vídeo…', icon: 'film', action: async () => {
        const paths = await window.api.openMedia('video');
        if (paths.length) App.library.importPaths(paths, { toTimeline: true });
      } },
      { label: 'Añadir texto en el cabezal', icon: 'type', action: App.addText },
      { label: 'Pegar ajustes en el clip seleccionado', icon: 'layers', disabled: !clipboard || !App.selectedClip(), action: () => C.pasteAttrs() },
      ...common,
    ];
  }

  C.mediaMenu = function (e, m) {
    const usable = m.info && !m.missing;
    contextMenu(e, [
      { header: m.name },
      { label: 'Añadir a la línea de tiempo', icon: 'plus', disabled: !usable, action: () => App.addClips([m.id]) },
      { label: 'Vista previa', icon: 'eye', disabled: !usable, action: () => App.library.preview(m.id) },
      { label: 'Abrir en Audio Studio', icon: 'wave', disabled: !usable || !m.info.hasAudio, action: () => openStudio(m) },
      { label: 'Cortar audio', icon: 'scissors', disabled: !usable || !m.info.hasAudio, action: () => openCutter(m) },
      m.info && m.info.kind !== 'audio' ? { label: 'Comprimir este vídeo', icon: 'compress', disabled: !usable,
        action: () => { App.showView('compressor'); App.compressor.load(m.path); } } : null,
      m.info && m.info.kind !== 'audio' ? { label: 'Estirar a 1920×1080 (16:9)', icon: 'maximize', disabled: !usable || (m.info.width === 1920 && m.info.height === 1080),
        title: 'Como escalador.bat: reescala a 16:9 sin bordes negros', action: () => App.capture.stretch(m.path, m.info) } : null,
      'sep',
      { label: 'Exportar fuentes…', icon: 'layers', disabled: !usable || !m.info.hasAudio, title: 'Guarda cada pista de audio (y el vídeo) por separado',
        action: () => App.capture.exportSources(m.path, m.info) },
      m.info && (m.info.audioTracks || []).length > 1 ? { label: 'Abrir con las pistas separadas', icon: 'film', disabled: !usable,
        title: 'Añade el vídeo y una pista de audio por fuente a la línea de tiempo', action: () => App.capture.splitToEditor(m) } : null,
      'sep',
      { label: 'Mostrar en la carpeta', icon: 'folder', action: () => showInFolder(m) },
      { label: 'Quitar de la biblioteca', icon: 'trash', danger: true, action: () => App.removeMedia(m.id) },
    ]);
  };

  // Clic derecho en la línea de tiempo.
  C.timelineMenu = function (e, timeAt) {
    const node = e.target.closest('.clip');
    if (node) {
      const { id, kind } = node.dataset;
      App.select(id, { kind });
      const item = kind === 'video' ? App.clip(id) : kind === 'audio' ? App.audioClip(id) : App.textClip(id);
      if (!item) return;
      contextMenu(e, kind === 'video' ? videoMenu(item) : kind === 'audio' ? audioMenu(item) : textMenu(item));
      return;
    }
    contextMenu(e, emptyMenu(e.target.closest('.tl-row'), Math.max(0, timeAt(e.clientX))));
  };
})();
