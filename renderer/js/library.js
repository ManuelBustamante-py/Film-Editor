/* Biblioteca de medios: importación, análisis y miniaturas (vídeo y audio). */
(function () {
  const App = window.App;
  const L = (App.library = {});
  const { state, store } = App;
  let filter = 'all';

  function metaLine(i) {
    if (i.kind === 'audio') return `${(i.acodec || '').toUpperCase()} · ${i.sampleRate ? `${Math.round(i.sampleRate / 100) / 10} kHz · ` : ''}${Core.formatBytes(i.size)}`;
    return `${i.width}×${i.height} · ${Core.fpsLabel(i.fpsStr)} fps · ${Core.formatBytes(i.size)}`;
  }

  function thumbFor(m) {
    const i = m.info;
    if (i && i.kind === 'audio') {
      return h('div', { class: 'media-thumb audio' },
        m.wave ? h('div', { class: 'wv', style: { backgroundImage: `url("${m.wave}")` } }) : null,
        h('span', { html: icon('music') }),
        h('span', { class: 'dur' }, Core.formatTime(i.duration, 0)));
    }
    return h('div', { class: 'media-thumb', style: m.thumbs ? { backgroundImage: `url("${m.thumbs.poster}")` } : null },
      m.loading ? h('div', { class: 'spin' }, h('div', { class: 'spinner' })) : null,
      i ? h('span', { class: 'dur' }, Core.formatTime(i.duration, 0)) : null);
  }

  const isCapture = (m) => !!m.capture || App.capture.isCapture(m.path);
  const multiTrack = (i) => !!i && i.kind !== 'audio' && (i.audioTracks || []).length > 1;

  function card(m) {
    const i = m.info;
    const usable = !!i && !m.missing;
    return h('div', {
      class: `media-card${state.selectedMediaId === m.id ? ' selected' : ''}${m.missing ? ' missing' : ''}`,
      draggable: usable,
      title: m.path,
      onclick: () => usable && L.preview(m.id),
      ondblclick: () => usable && App.addClips([m.id]),
      oncontextmenu: (e) => App.ctx.mediaMenu(e, m),
      ondragstart: (e) => {
        e.dataTransfer.setData('application/x-fotograma-media', m.id);
        e.dataTransfer.setData(`application/x-fotograma-${i.kind}`, '1');
        e.dataTransfer.effectAllowed = 'copy';
      },
    },
    thumbFor(m),
    h('div', { class: 'media-info' },
      h('div', { class: 'media-name' }, i && i.title ? i.title : m.name),
      h('div', { class: 'media-meta' }, m.error ? m.error : m.missing ? 'Archivo no encontrado' : i ? metaLine(i) : 'Analizando…'),
      i ? h('div', { class: 'media-meta' },
        i.kind === 'audio'
          ? h('span', { class: 'badge teal' }, i.artist || 'Audio')
          : `${(i.vcodec || '').toUpperCase()}${i.hasAudio ? ` · ${(i.acodec || '').toUpperCase()}` : ' · sin audio'}`,
        i.needsProxy ? ' ' : null, i.needsProxy ? h('span', { class: 'badge warn', title: 'Se usará una copia ligera para la vista previa' }, 'proxy') : null,
        isCapture(m) ? ' ' : null, isCapture(m) ? h('span', { class: 'badge accent' }, /^Grabaci/i.test(m.name) ? 'Grabación' : 'Clip') : null,
        multiTrack(i) ? ' ' : null, multiTrack(i) ? h('span', { class: 'badge', title: i.audioTracks.map((t) => t.name).join(' · ') }, `${i.audioTracks.length} pistas`) : null) : null),
    h('div', { class: 'media-actions' },
      usable ? h('button', { class: 'mini-btn', title: 'Añadir a la línea de tiempo', html: icon('plus'),
        onclick: (e) => { e.stopPropagation(); App.addClips([m.id]); } }) : null,
      usable && multiTrack(i) ? h('button', { class: 'mini-btn', title: 'Exportar fuentes (pistas de audio por separado)', html: icon('layers'),
        onclick: (e) => { e.stopPropagation(); App.capture.exportSources(m.path, i); } }) : null,
      usable && i.hasAudio ? h('button', { class: 'mini-btn', title: 'Abrir en Audio Studio', html: icon('wave'),
        onclick: (e) => { e.stopPropagation(); App.showView('studio'); App.studio.load(m.path); } }) : null,
      h('button', { class: 'mini-btn', title: 'Quitar de la biblioteca', html: icon('x'),
        onclick: (e) => { e.stopPropagation(); m.info ? App.removeMedia(m.id) : dropPending(m.id); } })));
  }

  function dropPending(id) {
    state.mediaIds = state.mediaIds.filter((x) => x !== id);
    L.render();
  }

  L.render = function () {
    const list = $('#media-list');
    list.innerHTML = '';
    const all = state.mediaIds.filter((id) => store.has(id)).map((id) => store.get(id));
    const shown = all.filter((m) => filter === 'all' || !m.info
      || (filter === 'capture' ? isCapture(m) : filter === 'audio' ? m.info.kind === 'audio' : m.info.kind !== 'audio'));
    if (!shown.length) {
      list.appendChild(h('div', { class: 'lib-empty', onclick: L.importDialog, html: icon('upload') },
        h('div', null, h('b', null, filter === 'capture' ? 'Aún no hay capturas' : filter === 'audio' ? 'Importa música o sonidos' : 'Importa vídeos y música')),
        h('div', { class: 'small' }, filter === 'capture' ? 'Los clips y grabaciones de la pestaña Captura aparecen aquí' : 'Haz clic o arrastra archivos aquí')));
    } else shown.forEach((m) => list.appendChild(card(m)));
    $('#btn-add-all').disabled = !all.some((m) => m.info && !m.missing);
  };

  L.preview = function (mediaId) {
    state.selectedMediaId = mediaId;
    L.render();
    App.player.setSourceMedia(mediaId);
  };

  L.importDialog = async function (kind = 'all') {
    const paths = await window.api.openMedia(typeof kind === 'string' ? kind : 'all');
    if (paths.length) return L.importPaths(paths);
    return [];
  };

  // Analiza y añade archivos a la biblioteca. Opcionalmente los inserta en la línea de tiempo.
  L.importPaths = async function (paths, { toTimeline = false, index, trackId, start, quiet = false } = {}) {
    const ids = [];
    const pending = [];
    for (const p of paths) {
      // También cuenta un archivo que aún se está analizando: así no se añade dos veces.
      const existing = [...store.values()].find((m) => m.path === p && (m.info || m.loading));
      if (existing) {
        if (!state.mediaIds.includes(existing.id)) state.mediaIds.push(existing.id);
        ids.push(existing.id);
        continue;
      }
      const m = { id: uid('m'), path: p, name: baseName(p), loading: true, info: null };
      store.set(m.id, m);
      state.mediaIds.push(m.id);
      ids.push(m.id);
      pending.push(m);
    }
    L.render();

    await Promise.all(pending.map(async (m) => {
      try {
        m.info = await window.api.probe(m.path);
        m.loading = false;
        L.loadAssets(m);
      } catch (e) {
        m.loading = false;
        m.error = cleanIpcError(e.message).split('\n').pop() || 'No se pudo leer el archivo';
        toast(`${m.name}: ${m.error}`, 'err', 6000);
      }
    }));

    const ok = ids.filter((id) => store.get(id) && store.get(id).info);
    state.mediaIds = state.mediaIds.filter((id) => { const m = store.get(id); return m && (m.info || m.loading); });
    if (toTimeline && ok.length) App.addClips(ok, index == null ? state.clips.length : index, { trackId, start });
    else {
      App.commit();
      if (ok.length && !quiet) toast(ok.length === 1 ? 'Archivo importado' : `${ok.length} archivos importados`, 'ok', 2000);
    }
    return ok;
  };

  // Miniaturas y forma de onda (en segundo plano).
  L.loadAssets = function (m) {
    if (m.info.kind !== 'audio') {
      window.api.thumbnails(m.path, m.info).then((t) => {
        m.thumbs = t;
        L.render();
        App.timeline.scheduleRender();
        App.inspector.refreshThumbs && App.inspector.refreshThumbs();
      }).catch(() => {});
    }
    if (m.info.hasAudio) {
      window.api.waveform(m.path).then((w) => { m.wave = w; L.render(); App.timeline.scheduleRender(); }).catch(() => {});
    }
  };

  L.init = function () {
    $('#btn-import').addEventListener('click', () => L.importDialog('all'));
    $('#btn-add-all').addEventListener('click', () => {
      const ids = state.mediaIds.filter((id) => { const m = store.get(id); return m && m.info && !m.missing; });
      App.addClips(ids);
    });
    $$('#lib-filter button').forEach((b) => b.addEventListener('click', () => {
      filter = b.dataset.f;
      $$('#lib-filter button').forEach((x) => x.classList.toggle('on', x === b));
      L.render();
    }));
    const list = $('#media-list');
    list.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      list.classList.add('drag-over');
    });
    list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('drag-over'); });
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.classList.remove('drag-over');
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
      if (paths.length) L.importPaths(paths);
    });
  };
})();
