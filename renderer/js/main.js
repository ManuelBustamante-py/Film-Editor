/* Arranque de la interfaz: pestañas, barra superior, atajos y redimensionado. */
(async function () {
  const App = window.App;
  const { state } = App;

  Icons.hydrate();
  App.library.init();
  App.player.init();
  App.timeline.init();
  App.inspector.init();
  App.studio.init();
  App.cutter.init();
  App.compressor.init();
  App.capture.init();

  // ------------------------------------------------------------------ lienzo
  const aspectSel = $('#sel-aspect');
  Core.ASPECTS.forEach((a) => aspectSel.appendChild(h('option', { value: a.id }, a.label)));
  aspectSel.addEventListener('change', () => {
    state.settings.aspect = aspectSel.value;
    App.setDirty(true);
    App.player.layout();
  });
  $$('#fit-toggle button').forEach((b) => b.addEventListener('click', () => {
    state.settings.fit = b.dataset.fit;
    App.setDirty(true);
    App.syncCanvasControls();
    App.player.layout();
  }));
  App.syncCanvasControls = function () {
    aspectSel.value = state.settings.aspect;
    $$('#fit-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.fit === state.settings.fit));
  };
  App.syncCanvasControls();

  // ------------------------------------------------------------------ pestañas
  function showView(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name !== 'editor' && App.player.playing) App.player.pause();
    if (name !== 'studio') App.studio.onHide();
    if (name !== 'cutter') App.cutter.onHide();
    if (name !== 'capture') App.capture.onHide();
    else App.capture.onShow();
    $('.topbar-actions').style.visibility = name === 'editor' ? '' : 'hidden';
    if (name === 'editor') { App.player.refresh(); App.timeline.render(); }
  }
  App.showView = showView;
  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

  // ------------------------------------------------------------------ barra superior
  $('#btn-new').addEventListener('click', App.project.newProject);
  $('#btn-open').addEventListener('click', App.project.open);
  $('#btn-save').addEventListener('click', () => App.project.save(false));
  $('#btn-undo').addEventListener('click', App.undo);
  $('#btn-redo').addEventListener('click', App.redo);
  $('#btn-export').addEventListener('click', App.exporter.open);

  // ------------------------------------------------------------------ divisor
  const splitter = $('#splitter');
  const view = $('#view-editor');
  try { const hgt = localStorage.getItem('tl-height'); if (hgt) view.style.setProperty('--tl-h', `${hgt}px`); } catch { /* ignorar */ }
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = view.getBoundingClientRect();
      const hgt = clamp(r.bottom - ev.clientY - 10, 200, r.height - 300);
      view.style.setProperty('--tl-h', `${hgt}px`);
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      try { localStorage.setItem('tl-height', parseInt(getComputedStyle(view).getPropertyValue('--tl-h'), 10)); } catch { /* ignorar */ }
      App.timeline.render();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });

  // ------------------------------------------------------------------ atajos
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' && !['range', 'checkbox'].includes(e.target.type)) return;
    if (tag === 'select' || tag === 'textarea') return;
    if ($('#modal-root').children.length) return;
    const editor = $('#view-editor').classList.contains('active');
    if (App.cutter.isActive()) { App.cutter.key(e); return; }
    if (App.studio.isActive()) {
      if (e.key === ' ') { e.preventDefault(); App.studio.toggle(); }
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (ctrl && k === 's') { e.preventDefault(); App.project.save(e.shiftKey); return; }
    if (ctrl && k === 'o') { e.preventDefault(); App.project.open(); return; }
    if (!editor) return;
    if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); App.undo(); return; }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); App.redo(); return; }
    if (ctrl && k === 'i') { e.preventDefault(); App.library.importDialog(); return; }
    if (ctrl && k === 'e') { e.preventDefault(); App.exporter.open(); return; }
    if (ctrl && e.shiftKey && k === 'c') { e.preventDefault(); App.ctx.copyAttrs(); return; }
    if (ctrl && e.shiftKey && k === 'v') { e.preventDefault(); App.ctx.pasteAttrs(); return; }
    if (ctrl && k === 'd') { e.preventDefault(); App.duplicateSelected(); return; }
    if (ctrl && k === 'k') { e.preventDefault(); App.splitAtPlayhead(); return; }
    if (ctrl) return;

    switch (e.key) {
      case ' ': e.preventDefault(); App.player.toggle(); break;
      case 'ArrowLeft': e.preventDefault(); e.shiftKey ? App.player.skip(-1) : App.player.stepFrame(-1); break;
      case 'ArrowRight': e.preventDefault(); e.shiftKey ? App.player.skip(1) : App.player.stepFrame(1); break;
      case 'Home': e.preventDefault(); App.player.toStart(); break;
      case 'End': e.preventDefault(); App.player.toEnd(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); App.removeSelected(); break;
      case 'Escape': if (App.player.cropEdit) App.player.setCropEdit(false); break;
      case '+': case '=': App.timeline.zoomBy(1.4); break;
      case '-': App.timeline.zoomBy(1 / 1.4); break;
      default:
        if (k === 's') App.splitAtPlayhead();
        else if (k === 'i') App.player.mode === 'source' ? App.player.markSource('in') : App.markAtPlayhead('in');
        else if (k === 'o') App.player.mode === 'source' ? App.player.markSource('out') : App.markAtPlayhead('out');
        else if (k === 'j') App.player.skip(-5);
        else if (k === 'l') App.player.skip(5);
        else if (k === 'k') App.player.pause();
        else if (k === 't') App.addText();
        else if (k === 'n') { state.snap = !state.snap; App.timeline.render(); toast(state.snap ? 'Imán activado' : 'Imán desactivado', 'info', 1200); }
        else if (k === 'f') App.player.toggleFullscreen();
    }
  });

  // Evita que soltar un archivo fuera de una zona válida abra el archivo en la ventana.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  window.api.onOpenFiles((paths) => { showView('editor'); App.library.importPaths(paths, { toTimeline: true }); });
  // Doble clic en la cabecera de una pista vacía o en la fila de textos.
  $('#tl-rows').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tl-row');
    if (row && row.dataset.row === 'text' && !e.target.closest('.clip')) App.addText();
  });

  App.resetHistory();
  App.render();
  App.setDirty(false);

  try {
    state.caps = await window.api.capabilities();
  } catch (e) {
    toast(`No se pudieron detectar los códecs de FFmpeg: ${cleanIpcError(e.message)}`, 'warn', 6000);
  }
  // Orden de los codificadores por GPU según el equipo (para «Automático» al exportar).
  window.captureApi.system().then((sys) => { if (sys && sys.ok && sys.value.rec) state.hwOrder = sys.value.rec.hwOrder; }).catch(() => {});
})();
