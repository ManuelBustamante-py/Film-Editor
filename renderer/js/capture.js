/*
 * Captura: búfer de repetición (clips al momento con atajo o con la voz), grabación
 * continua, fuentes de vídeo y audio con medidores, atajos globales, calibración de
 * sincronía y exportación de las fuentes de una grabación.
 */
(function () {
  const App = window.App;
  const api = window.captureApi;
  const X = (App.capture = {});

  let S = null;                 // ajustes (los guarda el proceso principal)
  let status = {};
  let devices = { audio: [], monitors: [], windows: [] };
  let caps = null;
  let resolutions = [];
  let voice = { state: 'off', models: {} };
  let hotkeyErrors = {};
  let recent = [];
  let pendingRestart = false;
  let visible = false;
  let sideTab = 'clips';
  let previewOn = true;
  let previewStream = null, previewKey = null, ffPreview = false;
  let meterCtx = null;
  const meters = new Map();     // id de fuente → { stream, analyser, buf, el }
  let meterRaf = 0;
  let voiceLevel = 0, voiceHeard = '', voiceDevices = [];
  const downloadPct = {};
  let root = null;
  let firstRun = false;

  const unwrap = async (p) => { const r = await p; if (!r.ok) throw new Error(r.error); return r.value; };
  const fmtClock = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return `${hh ? `${hh}:` : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
  };
  const kbd = (k) => (k ? h('span', { class: 'kbd' }, k) : null);
  try { previewOn = localStorage.getItem('cap-preview') !== '0'; } catch { /* ignorar */ }

  // ------------------------------------------------------------------ ajustes
  let saveTimer = null, pendingPatch = {};
  async function set(patch, { debounce = 0 } = {}) {
    Object.assign(S, patch);
    Object.assign(pendingPatch, patch);
    clearTimeout(saveTimer);
    const flush = async () => {
      const p = pendingPatch;
      pendingPatch = {};
      try {
        const r = await unwrap(api.setSettings(p));
        S = r.settings;
        hotkeyErrors = r.hotkeyErrors || {};
        voice = { ...voice, ...r.voice };
        if (r.needsRestart) pendingRestart = true;
        renderBanner();
      } catch (e) { toast(e.message, 'err'); }
    };
    if (debounce) saveTimer = setTimeout(flush, debounce);
    else await flush();
  }

  // ------------------------------------------------------------------ estructura
  X.init = async function () {
    root = $('#capture');
    root.append(
      h('div', { class: 'cap-main' },
        h('div', { class: 'cap-stage glass' },
          h('video', { id: 'cap-preview', muted: true, autoplay: true, playsInline: true }),
          h('img', { id: 'cap-preview-img', class: 'cap-preview-img', hidden: true, alt: '' }),
          h('div', { class: 'cap-preview-off', id: 'cap-preview-off' }),
          h('div', { class: 'cap-hud', id: 'cap-hud' }),
          h('label', { class: 'cap-prev-toggle check-row', title: 'La vista previa usa un poco de GPU; puedes apagarla mientras juegas' },
            h('input', { type: 'checkbox', class: 'switch', checked: previewOn, onchange: (e) => {
              previewOn = e.target.checked;
              try { localStorage.setItem('cap-preview', previewOn ? '1' : '0'); } catch { /* ignorar */ }
              updatePreview();
            } }), 'Vista previa')),
        h('div', { class: 'cap-controls glass', id: 'cap-controls' }),
        h('div', { id: 'cap-banner' }),
        h('div', { class: 'cap-cards' },
          h('div', { class: 'cap-card glass', id: 'cap-video' }),
          h('div', { class: 'cap-card glass', id: 'cap-mixer' }))),
      h('aside', { class: 'cap-side glass' },
        h('div', { class: 'cap-side-tabs' },
          h('div', { class: 'seg block', id: 'cap-side-seg' },
            ...[['clips', 'Capturas'], ['settings', 'Ajustes'], ['voice', 'Voz'], ['stats', 'Estadísticas']].map(([id, label]) =>
              h('button', { 'data-t': id, class: id === sideTab ? 'on' : '', onclick: () => { sideTab = id; renderSide(); } }, label)))),
        h('div', { class: 'cap-side-body', id: 'cap-side' })));

    // Con la ventana en segundo plano (jugando) la interfaz no se redibuja ni anima: con una
    // gráfica integrada, cada repintado de los paneles de cristal le quitaba tiempo de GPU a la
    // captura y el clip perdía imágenes. Al volver a la ventana se pone al día.
    let idle = !document.hasFocus();
    const setIdle = (on) => {
      idle = on;
      document.body.classList.toggle('bg-idle', on);
      if (!on) { renderControls(); renderStatsLive(); }
    };
    document.body.classList.toggle('bg-idle', idle);
    api.onStatus((s) => {
      const changed = !!s.buffer !== !!status.buffer || !!s.recording !== !!status.recording;
      status = s;
      if (!idle || changed) { renderControls(); renderStatsLive(); }
    });
    // La vista previa y los medidores también se pausan: son capturas extra que competirían con la grabación.
    window.addEventListener('blur', () => { setIdle(true); if (!visible) return; previewKey = null; stopPreview(); stopMeters(); });
    window.addEventListener('focus', () => { setIdle(false); if (!visible) return; updatePreview(); startMeters(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) setIdle(true); else if (document.hasFocus()) setIdle(false); });
    // Vista previa de ventanas: imágenes JPEG que envía FFmpeg.
    let frameUrl = null;
    api.onFrame((bytes) => {
      const img = $('#cap-preview-img');
      if (!img || !ffPreview) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      img.onload = () => { if (frameUrl && frameUrl !== url) URL.revokeObjectURL(frameUrl); frameUrl = url; };
      img.src = url;
      if (img.hidden) { img.hidden = false; $('#cap-preview-off').hidden = true; }
    });
    api.onFrameEnd((d) => {
      if (!ffPreview) return;
      ffPreview = false;
      const img = $('#cap-preview-img');
      if (img) img.hidden = true;
      const off = $('#cap-preview-off');
      off.innerHTML = '';
      off.hidden = false;
      off.append(h('div', { html: icon('alert') }), h('div', null, `Sin vista previa: ${d.message}. Comprueba que la ventana no esté minimizada.`));
      previewKey = null;
    });
    api.onEvent(onEvent);
    api.onVoice(onVoice);

    try {
      const st = await unwrap(api.state());
      S = st.settings;
      status = st.status;
      hotkeyErrors = st.hotkeyErrors || {};
      resolutions = st.resolutions;
      firstRun = !!st.firstRun;
      voice = { ...voice, ...st.voice };
      recent = await unwrap(api.recent());
    } catch (e) {
      root.textContent = `No se pudo iniciar la captura: ${e.message}`;
      return;
    }
    renderAll();
    unwrap(api.caps()).then((c) => { caps = c; renderVideo(); renderSide(); }).catch(() => {});
    refreshDevices();
  };

  async function refreshDevices(opts) {
    try {
      devices = await unwrap(api.devices(opts));
      // Primera vez: monitor principal y, si existe, el micrófono como fuente.
      if (firstRun && !S.audio.length && devices.audio.length) {
        firstRun = false;
        const mic = devices.audio.find((d) => /micr|mic\b/i.test(d.name) && !/voicemeeter/i.test(d.name)) || devices.audio[0];
        await set({ audio: [newSource(mic)] });
      }
    } catch (e) { toast(`No se pudieron listar los dispositivos: ${e.message}`, 'err'); }
    renderVideo();
    renderMixer();
    if (visible) { updatePreview(); startMeters(); }
  }

  function renderAll() {
    renderControls();
    renderBanner();
    renderVideo();
    renderMixer();
    renderSide();
  }

  // ------------------------------------------------------------------ controles
  function renderControls() {
    const c = $('#cap-controls');
    if (!c || !S) return;
    const hk = S.hotkeys || {};
    const st = status;
    c.innerHTML = '';
    c.append(
      h('button', {
        class: `btn big cap-buf${st.buffer ? ' on' : ''}`, disabled: st.starting && !st.buffer,
        title: `Mantiene en memoria los últimos ${S.bufferSec} s para guardarlos al momento${hk.buffer ? ` (${hk.buffer})` : ''}`,
        onclick: () => act(st.buffer ? api.stopBuffer() : api.startBuffer()),
        html: icon(st.buffer ? 'stop' : 'loop'),
      }, st.waiting ? `Esperando a ${st.waiting}… (cancelar)` : st.buffer ? 'Detener búfer' : st.starting ? 'Iniciando…' : 'Iniciar búfer', kbd(hk.buffer)),
      h('button', {
        class: 'btn big primary cap-clip', disabled: !st.buffer,
        title: 'Guarda los últimos segundos del búfer', onclick: () => act(api.saveClip()), html: icon('bolt'),
      }, 'Guardar clip', kbd(hk.clip)),
      bufferSelect(),
      h('button', {
        class: `btn big cap-rec${st.recording ? ' on' : ''}`, disabled: st.starting && !st.recording,
        onclick: () => act(st.recording ? api.stopRecording() : api.startRecording()), html: icon(st.recording ? 'stop' : 'rec'),
      }, st.recording ? `Detener · ${fmtClock(st.recTime)}` : 'Grabar', kbd(hk.record)),
      ...(st.recording ? [h('button', {
        class: `btn big cap-pause${st.paused ? ' on' : ''}`, title: 'Pausa la grabación (el búfer de repetición sigue funcionando)',
        onclick: () => act(api.pauseRecording()), html: icon(st.paused ? 'play' : 'pause'),
      }, st.paused ? 'Reanudar' : 'Pausa', kbd(hk.pause))] : []),
      h('button', {
        class: 'btn big icon-only', disabled: !st.running, title: `Poner un marcador: queda como capítulo en el clip o la grabación${hk.mark ? ` (${hk.mark})` : ''}`,
        onclick: () => act(api.mark()), html: icon('flag'),
      }),
      h('button', {
        class: 'btn big icon-only', title: `Captura de pantalla en PNG${hk.screenshot ? ` (${hk.screenshot})` : ''}`,
        onclick: () => act(api.screenshot()), html: icon('camera'),
      }),
      h('div', { class: 'spacer' }),
      voiceChip());
    renderHud();
  }

  // Duración del búfer (= duración del clip): se cambia al momento, sin reiniciar la captura.
  const BUF_OPTS = [10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900];
  const fmtSec = (s) => (s < 60 ? `${s} s` : s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`);
  function setBuffer(sec) {
    const v = Math.max(5, Math.min(1800, Math.round(Number(sec) || 60)));
    set({ bufferSec: v });
    renderControls();
    if (sideTab === 'settings' || sideTab === 'clips') renderSide();
    toast(`Búfer de ${fmtSec(v)}: los clips guardarán los últimos ${fmtSec(v)}`, 'info', 2200);
  }
  function bufferSelect() {
    const opts = [...new Set([...BUF_OPTS, S.bufferSec])].sort((a, b) => a - b);
    return h('label', { class: 'cap-buflen', title: 'Duración del búfer: cuántos segundos guarda cada clip' }, h('span', { html: icon('loop') }),
      h('select', { onchange: (e) => { if (e.target.value === 'custom') { sideTab = 'settings'; renderSide(); setTimeout(() => { const i = $('#cap-buf-custom'); if (i) { i.focus(); i.select(); } }, 50); renderControls(); } else setBuffer(e.target.value); } },
        ...opts.map((s) => h('option', { value: String(s), selected: s === S.bufferSec }, fmtSec(s))),
        h('option', { value: 'custom' }, 'Personalizado…')));
  }

  function voiceChip() {
    const v = S.voice;
    const st = voice.state;
    const txt = !v.enabled ? 'Voz desactivada' : st === 'listening' ? `Di «${v.phrases[0] || '…'}»` : st === 'loading' ? 'Cargando voz…'
      : st === 'nomodel' ? 'Falta el modelo de voz' : st === 'error' ? 'Error de voz' : 'Voz en pausa';
    return h('button', {
      class: `cap-voice-chip ${v.enabled ? st : 'off'}`, title: voice.message || 'Comando de voz para guardar clips',
      onclick: () => { sideTab = 'voice'; renderSide(); },
    }, h('span', { class: 'vdot', style: { '--lv': String(Math.min(1, voiceLevel * 2.5)) } }), h('span', { html: icon('mic') }), txt);
  }

  function renderHud() {
    const hud = $('#cap-hud');
    if (!hud) return;
    const st = status;
    const live = $('#tab-live');
    if (live) {
      live.hidden = !(st.buffer || st.recording);
      live.classList.toggle('rec', !!st.recording);
      live.title = st.recording ? 'Grabando' : 'Búfer de repetición activo';
    }
    hud.innerHTML = '';
    if (st.waiting) hud.append(h('span', { class: 'hud-pill warn' }, `ESPERANDO A ${st.waiting.toUpperCase()} (MINIMIZADO)`));
    if (st.reconnecting) hud.append(h('span', { class: 'hud-pill warn' }, 'RECONECTANDO… (EL BÚFER SE CONSERVA)'));
    if (st.recording) hud.append(h('span', { class: `hud-pill rec${st.paused ? ' paused' : ''}` }, h('i'), `${st.paused ? 'EN PAUSA' : 'REC'} ${fmtClock(st.recTime)}`));
    if (st.marks) hud.append(h('span', { class: 'hud-pill', title: 'Marcadores en el búfer o la grabación', html: icon('flag') }, String(st.marks)));
    if (st.buffer) hud.append(h('span', { class: 'hud-pill buf' }, `BÚFER ${Math.floor(st.available || 0)}/${st.bufferSec} s`));
    if (st.running) {
      if (st.realFps != null) {
        // Imágenes nuevas que entrega Windows: si es baja, el clip se verá a saltos aunque sea de 60 fps.
        const low = st.realFps < S.video.fps * 0.75;
        hud.append(h('span', { class: `hud-pill${low ? ' warn' : ''}`, title: 'Imágenes nuevas por segundo que llegan desde Windows. Con la pantalla quieta es normal que baje.' },
          `Captura real ${Math.round(st.realFps)}/${S.video.fps} fps`));
      } else hud.append(h('span', { class: 'hud-pill' }, `${(st.fps || 0).toFixed(0)} fps`));
      if (st.encoder) hud.append(h('span', { class: 'hud-pill' }, st.encoder));
      if (st.size) hud.append(h('span', { class: 'hud-pill', title: 'Tamaño fijo durante toda la captura: si el juego cambia de resolución, la imagen se adapta a este tamaño' }, `${st.size.w}×${st.size.h}`));
      if (st.tracks && st.tracks.length) hud.append(h('span', { class: 'hud-pill', title: st.tracks.join(' · ') }, `${st.tracks.length} pista${st.tracks.length > 1 ? 's' : ''} de audio`));
    }
  }

  function renderStatsLive() {
    if (sideTab === 'stats') renderSide();
  }

  async function act(p) {
    try { await unwrap(p); } catch (e) { toast(e.message, 'err', 7000); }
  }

  function renderBanner() {
    const b = $('#cap-banner');
    if (!b) return;
    b.innerHTML = '';
    if (pendingRestart && status.running) {
      b.append(h('div', { class: 'warnbox info cap-restart', html: icon('info') },
        h('div', null, 'Hay cambios que se aplican al reiniciar la captura.'),
        h('button', { class: 'btn small accent', onclick: async () => {
          try { await unwrap(api.restart()); pendingRestart = false; renderBanner(); toast('Captura reiniciada con los nuevos ajustes', 'ok'); } catch (e) { toast(e.message, 'err'); }
        } }, 'Aplicar ahora')));
    } else pendingRestart = false;
  }

  // ------------------------------------------------------------------ vídeo
  function renderVideo() {
    const c = $('#cap-video');
    if (!c || !S) return;
    const v = S.video;
    c.innerHTML = '';
    const head = h('div', { class: 'cap-card-head' }, h('span', { html: icon(v.source === 'window' ? 'window' : 'monitor') }), h('h3', null, 'Fuente de vídeo'),
      h('button', { class: 'btn small ghost', title: 'Prueba cada método de captura con el juego en marcha y aplica el más fluido', html: icon('sparkle'), onclick: optimize }, 'Optimizar fluidez'),
      h('button', { class: 'btn small ghost icon-only', title: 'Actualizar pantallas y ventanas', html: icon('reset'), onclick: () => refreshDevices({ refreshMonitors: true }) }));
    const seg = h('div', { class: 'seg block' },
      ...[['monitor', 'Pantalla'], ['window', 'Ventana o juego']].map(([id, label]) =>
        h('button', { class: v.source === id ? 'on' : '', onclick: () => setVideo({ source: id }) }, label)));
    let picker;
    if (v.source === 'window') {
      const wins = devices.windows || [];
      const cur = v.window;
      const open = !!cur && wins.some((w) => w.exe.toLowerCase() === cur.exe.toLowerCase());
      const sel = h('select', { id: 'cap-window-sel', onchange: (e) => { const w = wins[Number(e.target.value)]; if (w) setVideo({ window: { exe: w.exe, title: w.title } }); } },
        h('option', { value: '' }, wins.length ? 'Elige una ventana…' : 'No hay ventanas'),
        // La ventana elegida se conserva aunque el programa esté cerrado ahora mismo.
        cur && !open ? h('option', { value: '', selected: true }, `${cur.exe.replace(/\.exe$/i, '')} — no está abierto`) : null,
        ...wins.map((w, i) => h('option', { value: String(i), selected: open && cur.exe.toLowerCase() === w.exe.toLowerCase() }, `${w.exe.replace(/\.exe$/i, '')} — ${w.title.trim().slice(0, 60)}`)));
      picker = h('div', { class: 'field' }, h('span', null, 'Ventana'), sel,
        cur ? h('div', { class: 'hint' }, `Se busca por programa (${cur.exe}) cada vez que empieza la captura. Si minimizas la ventana, la imagen se pausa; para juegos a pantalla completa es mejor «Pantalla».`) : null,
        caps && !caps.gfxcapture ? h('div', { class: 'warnbox', html: icon('alert') }, h('div', null, 'Tu FFmpeg no incluye Windows Graphics Capture: se usará un método más lento. Para juegos, usa «Pantalla».')) : null);
    } else {
      const mons = devices.monitors || [];
      picker = h('div', { class: 'field' }, h('span', null, 'Pantalla'),
        h('select', { onchange: (e) => setVideo({ monitor: Number(e.target.value) }) },
          ...(mons.length ? mons : [{ idx: 0, label: 'Pantalla 1' }]).map((m) => h('option', { value: String(m.idx), selected: m.idx === v.monitor }, m.label))));
    }
    const fpsChips = h('div', { class: 'chips' }, ...[30, 60, 120, 144, 165, 240].map((f) =>
      h('button', { class: `chip mono${v.fps === f ? ' on' : ''}`, onclick: () => setVideo({ fps: f }) }, String(f))));
    const res = h('select', { onchange: (e) => setVideo({ resolution: e.target.value }) },
      ...resolutions.map((r) => h('option', { value: r.id, selected: r.id === v.resolution }, r.label)));
    const mon = (devices.monitors || []).find((m) => m.idx === v.monitor);
    c.append(head, seg, picker,
      v.source === 'monitor' ? h('div', { class: 'field' }, h('span', null, 'Método de captura'),
        h('div', { class: 'seg block' }, ...[['auto', 'Automático'], ['wgc', 'Graphics Capture'], ['dda', 'Desktop Duplication']].map(([id, l]) =>
          h('button', { class: (v.method || 'auto') === id ? 'on' : '', disabled: id === 'wgc' && caps && !caps.gfxcapture, onclick: () => setVideo({ method: id }) }, l))),
        h('div', { class: 'hint' }, 'Automático usa Desktop Duplication con conversión en la GPU: en las pruebas con juegos a pantalla completa fue lo más fluido. «Captura real» en el visor muestra las imágenes nuevas por segundo.')) : null,
      h('div', { class: 'field' }, h('span', null, 'Fotogramas por segundo'), fpsChips),
      h('div', { class: 'field' }, h('span', null, 'Resolución de salida'), res,
        h('div', { class: 'hint' }, v.resolution === 'native'
          ? `Se graba tal cual${v.source === 'monitor' && mon ? ` (${mon.width}×${mon.height})` : ''}: sin reescalar ni bordes negros.`
          : 'Se graba a la resolución nativa (lo más fluido) y se estira al guardar el clip, en la GPU (unos segundos).')),
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', class: 'switch', checked: v.cursor, onchange: (e) => setVideo({ cursor: e.target.checked }) }), 'Capturar el cursor'));
  }

  function setVideo(p) {
    set({ video: { ...S.video, ...p } });
    renderVideo();
    if (visible) updatePreview();
    if (p.source === 'window') refreshWindows();
  }

  // La lista de ventanas se actualiza sola mientras la pestaña está abierta
  // (por ejemplo, al abrir el juego después de entrar en Captura).
  let winTimer = 0, winKey = '';
  async function refreshWindows() {
    if (!visible || !S || S.video.source !== 'window') return;
    if (document.activeElement && document.activeElement.id === 'cap-window-sel') return;
    try {
      const list = await unwrap(api.windows());
      const key = JSON.stringify(list.map((w) => [w.exe, w.title]));
      if (key === winKey) return;
      winKey = key;
      devices.windows = list;
      if (!(document.activeElement && document.activeElement.id === 'cap-window-sel')) renderVideo();
      // Si el programa elegido se acaba de abrir, se reintenta la vista previa.
      if (!previewStream && !ffPreview) { previewKey = null; updatePreview(); }
    } catch { /* ignorar */ }
  }

  // ------------------------------------------------------------------ mezclador
  function newSource(d) {
    return { id: uid('s'), device: d.name, alt: d.alt, label: d.name.replace(/\s*\(.*\)\s*$/, '').replace(/^Voicemeeter /, 'VM ') || d.name, volume: 1, muted: false, offsetMs: 0, enabled: true };
  }

  function renderMixer() {
    const c = $('#cap-mixer');
    if (!c || !S) return;
    c.innerHTML = '';
    const used = new Set(S.audio.map((a) => a.device));
    const free = devices.audio.filter((d) => !used.has(d.name));
    c.append(h('div', { class: 'cap-card-head' }, h('span', { html: icon('volume') }), h('h3', null, 'Mezclador de audio'),
      h('button', { class: 'btn small ghost', title: 'Mide y corrige el retraso de cada fuente con destellos y pitidos', html: icon('target'),
        disabled: !S.audio.length, onclick: calibrate }, 'Calibrar'),
      h('button', { class: 'btn small ghost', title: 'Descubre qué programa suena en cada fuente (por ejemplo, qué bus de Voicemeeter lleva el juego)', html: icon('eye'),
        disabled: !S.audio.length, onclick: identifyAudio }, 'Identificar')));
    const list = h('div', { class: 'mix-list' });
    if (!S.audio.length) list.append(h('div', { class: 'hint mix-empty' }, 'Sin fuentes de audio: el vídeo se grabará en silencio. Añade tu micrófono y las salidas de Voicemeeter que quieras.'));
    S.audio.forEach((a) => list.append(mixRow(a)));
    c.append(list);
    const add = h('select', { class: 'mix-add', onchange: (e) => {
      const d = devices.audio.find((x) => x.name === e.target.value);
      if (d) { set({ audio: [...S.audio, newSource(d)] }); renderMixer(); startMeters(); }
    } }, h('option', { value: '' }, free.length ? '+ Añadir fuente de audio…' : 'No hay más dispositivos'), ...free.map((d) => h('option', { value: d.name }, d.name)));
    c.append(h('div', { class: 'mix-foot' }, add,
      h('label', { class: 'check-row', title: 'Además de la mezcla, guarda cada fuente en su propia pista (como las pistas de OBS)' },
        h('input', { type: 'checkbox', class: 'switch', checked: S.separateTracks, onchange: (e) => set({ separateTracks: e.target.checked }) }), 'Pistas separadas'),
      h('label', { class: 'check-row', title: 'Evita que la mezcla sature cuando varias fuentes suenan fuerte a la vez' },
        h('input', { type: 'checkbox', class: 'switch', checked: S.mixLimiter !== false, onchange: (e) => set({ mixLimiter: e.target.checked }) }), 'Limitador')));
    c.append(h('div', { class: 'hint' }, 'El volumen y el silencio se aplican al momento, sin reiniciar la captura.'));
    if (S.audio.length > 1 && S.separateTracks) c.append(h('div', { class: 'hint' }, `Pista 1: mezcla · pistas 2–${S.audio.length + 1}: cada fuente por separado (exportables desde Medios).`));
  }

  const fxOpen = new Set();     // fuentes con los filtros desplegados

  function mixRow(a) {
    const upd = (p, opts) => { Object.assign(a, p); set({ audio: S.audio.map((x) => (x.id === a.id ? { ...a } : x)) }, opts); };
    const vol = h('input', { type: 'range', min: 0, max: 200, step: 1, value: Math.round(a.volume * 100),
      oninput: (e) => { volVal.textContent = `${e.target.value}%`; upd({ volume: Number(e.target.value) / 100 }, { debounce: 120 }); } });
    const volVal = h('span', { class: 'mix-val' }, `${Math.round(a.volume * 100)}%`);
    requestAnimationFrame(() => paintRange(vol));
    const meter = h('div', { class: 'mix-meter' }, h('div', { class: 'mm-fill' }), h('div', { class: 'mm-peak' }));
    const row = h('div', { class: `mix-row${a.muted ? ' muted' : ''}`, 'data-id': a.id },
      h('div', { class: 'mix-top' },
        h('input', { type: 'text', class: 'mix-name', value: a.label, title: 'Nombre de la pista', onchange: (e) => upd({ label: e.target.value.trim() || a.device }) }),
        h('button', { class: `btn small ghost mix-fx-btn${Object.values(a.fx || {}).some(Boolean) ? ' active' : ''}`, title: 'Filtros de audio (reducción de ruido, puerta, compresor)',
          onclick: () => { fxOpen.has(a.id) ? fxOpen.delete(a.id) : fxOpen.add(a.id); renderMixer(); startMeters(); } }, 'FX'),
        h('button', { class: `btn small icon-only ghost${a.muted ? ' active' : ''}`, title: a.muted ? 'Activar' : 'Silenciar', html: icon(a.muted ? 'mute' : 'volume'),
          onclick: () => { upd({ muted: !a.muted }); renderMixer(); startMeters(); } }),
        h('button', { class: 'btn small icon-only ghost', title: 'Quitar fuente', html: icon('trash'),
          onclick: () => { set({ audio: S.audio.filter((x) => x.id !== a.id) }); renderMixer(); startMeters(); } })),
      h('div', { class: 'mix-dev small muted', title: a.device }, a.device),
      meter,
      h('div', { class: 'mix-ctrls' }, vol, volVal,
        h('label', { class: 'mix-off', title: 'Desfase de sincronía (ms). Negativo adelanta el audio.' }, 'Sinc.',
          h('input', { type: 'number', step: 5, value: a.offsetMs || 0, onchange: (e) => upd({ offsetMs: Math.round(Number(e.target.value) || 0) }) }), 'ms')),
      fxOpen.has(a.id) ? h('div', { class: 'mix-fx' },
        ...[['denoise', 'Reducir ruido', 'Quita el ruido de fondo constante (ventilador, aire acondicionado)'],
          ['gate', 'Puerta de ruido', 'Silencia la fuente cuando no hablas'],
          ['comp', 'Compresor', 'Iguala el volumen: sube lo suave y contiene los gritos']].map(([k, l, t]) =>
          h('button', { class: `chip${(a.fx || {})[k] ? ' on' : ''}`, title: t, onclick: () => { upd({ fx: { ...(a.fx || {}), [k]: !(a.fx || {})[k] } }); renderMixer(); startMeters(); } }, l))) : null);
    return row;
  }

  // Medidores en vivo (getUserMedia sobre los mismos dispositivos).
  async function startMeters() {
    stopMeters();
    if (!visible || !S.audio.length) return;
    let inputs = [];
    try {
      inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      if (!inputs.some((d) => d.label)) {
        (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
        inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      }
    } catch { return; }
    voiceDevices = inputs.map((d) => d.label).filter((l) => l && !/^(Predeterminado|Default|Comunicaciones|Communications)\s*-/.test(l));
    if (!meterCtx) meterCtx = new AudioContext();
    if (meterCtx.state !== 'running') meterCtx.resume().catch(() => {});
    for (const a of S.audio) {
      const short = a.device.replace(/\s*\(.*\)\s*$/, '');
      const d = inputs.find((x) => x.label === a.device) || inputs.find((x) => x.label.startsWith(short));
      if (!d) continue;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        if (!visible) { stream.getTracks().forEach((t) => t.stop()); return; }
        const src = meterCtx.createMediaStreamSource(stream);
        const analyser = meterCtx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        meters.set(a.id, { stream, analyser, buf: new Float32Array(analyser.fftSize), peak: 0, peakT: 0 });
      } catch { /* dispositivo ocupado o sin permiso */ }
    }
    const loop = () => {
      meterRaf = requestAnimationFrame(loop);
      for (const a of S.audio) {
        const m = meters.get(a.id);
        const el = root.querySelector(`.mix-row[data-id="${a.id}"] .mix-meter`);
        if (!el) continue;
        let lvl = 0;
        if (m) {
          m.analyser.getFloatTimeDomainData(m.buf);
          let pk = 0;
          for (let i = 0; i < m.buf.length; i++) pk = Math.max(pk, Math.abs(m.buf[i]));
          pk *= a.muted ? 0 : a.volume;
          const db = pk > 0 ? 20 * Math.log10(pk) : -90;
          lvl = clamp((db + 60) / 60, 0, 1);
          const now = performance.now();
          if (lvl >= m.peak || now - m.peakT > 1200) { m.peak = lvl; m.peakT = now; }
          el.lastChild.style.left = `${m.peak * 100}%`;
        }
        el.firstChild.style.width = `${(1 - lvl) * 100}%`;
        el.classList.toggle('none', !m);
      }
    };
    loop();
  }

  function stopMeters() {
    cancelAnimationFrame(meterRaf);
    for (const m of meters.values()) m.stream.getTracks().forEach((t) => t.stop());
    meters.clear();
  }

  // Optimizador de fluidez: con el juego en marcha, mide cada combinación y aplica la mejor.
  async function optimize() {
    if (status.recording) { toast('Detén la grabación antes de optimizar.', 'warn'); return; }
    let off = null;
    const md = modal({
      title: 'Optimizar fluidez de la captura',
      body: h('div', { class: 'cal-body' },
        h('p', null, 'Se prueban los métodos de captura con tu juego en marcha y se mide cuántas imágenes nuevas por segundo llegan con cada uno. Tarda unos 40 segundos.'),
        h('ol', { class: 'opt-steps' },
          h('li', null, 'Pulsa «Empezar» y vuelve al juego (tienes 8 segundos).'),
          h('li', null, 'Juega o muévete con normalidad hasta oír el segundo aviso.'),
          h('li', null, 'Vuelve aquí para ver el resultado: se aplica solo.')),
        h('div', { class: 'cal-result', id: 'opt-result' })),
      foot: [h('button', { class: 'btn ghost', onclick: () => md.close() }, 'Cerrar'),
        h('button', { class: 'btn primary', id: 'opt-go', html: icon('sparkle'), onclick: run }, 'Empezar')],
      onClose: () => { if (off) off(); },
    });
    async function run() {
      const out = $('#opt-result');
      $('#opt-go').disabled = true;
      md.setLocked(true);
      for (let s = 8; s > 0; s--) {
        out.innerHTML = '';
        out.append(h('div', { class: 'opt-count' }, `Vuelve al juego… ${s}`));
        await new Promise((r) => setTimeout(r, 1000));
      }
      chime('start');
      out.innerHTML = '';
      const line = h('div', { class: 'row' }, h('div', { class: 'spinner' }), 'Probando…');
      out.append(line);
      off = api.onBench((st) => { line.lastChild.textContent = `Probando ${st.i}/${st.total}: ${st.label}`; });
      try {
        const r = await unwrap(api.benchmark());
        chime('ok');
        out.innerHTML = '';
        const max = Math.max(1, ...r.results.map((x) => x.fps));
        out.append(h('div', { class: 'cal-table' }, ...r.results.map((x) => {
          const isBest = r.best && x.method === r.best.method && x.conv === r.best.conv && x.gpu === r.best.gpu;
          return h('div', { class: `cal-row opt-row${isBest ? ' best' : ''}` },
            h('span', null, `${x.label} · ${x.convLabel}${x.gpu === 'high' ? ' · prioridad alta' : ' · prioridad máxima'}`),
            h('b', null, x.error ? '—' : `${Math.round(x.fps)} fps`),
            h('div', { class: 'opt-bar' }, h('div', { style: { width: `${(x.fps / max) * 100}%` } })));
        })));
        if (r.best && r.best.fps > 0) {
          set({ video: { ...S.video, method: S.video.source === 'monitor' ? r.best.method : S.video.method, conv: r.best.conv }, gpuPriority: r.best.gpu });
          renderVideo();
          renderSide();
          out.append(h('div', { class: 'warnbox info', html: icon('check') }, h('div', null, `Aplicado lo más fluido: ${Math.round(r.best.fps)} de ${r.target} fps.`)));
        }
        if (!r.best || r.best.fps < r.target * 0.6) {
          out.append(h('div', { class: 'warnbox', html: icon('alert') }, h('div', null,
            'Windows entrega pocas imágenes del juego. Suele pasar con la pantalla completa exclusiva o con la tarjeta al 100 %. Lo que más ayuda: limitar los fps del juego (por ejemplo a 120) o jugar en «Pantalla completa sin bordes» con la resolución de Windows puesta en la del juego (1440×1044); así no cambia de modo y la captura recibe todas las imágenes.')));
        }
      } catch (e) {
        out.innerHTML = '';
        out.append(h('div', { class: 'warnbox err', html: icon('alert') }, h('div', null, e.message)));
      } finally {
        if (off) { off(); off = null; }
        md.setLocked(false);
        const go = $('#opt-go');
        if (go) go.disabled = false;
      }
    }
  }

  // Qué programa suena en cada fuente: compara la actividad de cada programa con cada fuente.
  async function identifyAudio() {
    const md = modal({
      title: 'Identificar fuentes de audio',
      body: h('div', { class: 'cal-body' },
        h('p', null, 'Durante unos segundos se compara lo que suena en cada programa (juego, Spotify, Discord…) con la señal de cada fuente. Haz que suenen: pon música y dispara o muévete en el juego.'),
        h('div', { class: 'cal-result', id: 'id-result' })),
      foot: [h('button', { class: 'btn ghost', onclick: () => md.close() }, 'Cerrar'),
        h('button', { class: 'btn primary', id: 'id-go', html: icon('eye'), onclick: run }, 'Empezar')],
    });
    async function run() {
      const out = $('#id-result');
      $('#id-go').disabled = true;
      md.setLocked(true);
      out.innerHTML = '';
      out.append(h('div', { class: 'row' }, h('div', { class: 'spinner' }), 'Escuchando… (unos 10 segundos)'));
      try {
        const r = await unwrap(api.identifyAudio());
        out.innerHTML = '';
        if (!r.apps.length) out.append(h('div', { class: 'warnbox', html: icon('alert') }, h('div', null, 'No sonaba ningún programa. Pon algo de audio y vuelve a intentarlo.')));
        const rename = [];
        out.append(h('div', { class: 'cal-table' }, ...r.sources.map((s) => {
          const best = s.matches[0];
          const sure = best && best.score >= 0.6 && s.level > 0.003;
          const app = best ? best.app.replace(/-Win64-Shipping$/i, '').replace(/\.exe$/i, '') : '';
          if (sure) rename.push({ id: s.id, label: app.charAt(0).toUpperCase() + app.slice(1).toLowerCase() });
          return h('div', { class: 'cal-row' },
            h('span', null, h('b', null, s.label || s.device), h('div', { class: 'small muted' }, s.device)),
            h('b', { class: sure ? '' : 'muted' }, s.level <= 0.003 ? 'silencio' : sure ? app : 'dudoso'),
            h('span', { class: 'small muted' }, s.level <= 0.003 ? 'no llega sonido' : best ? `coincide ${Math.round(Math.max(0, best.score) * 100)} %` : ''));
        })));
        if (rename.some((x) => (S.audio.find((a) => a.id === x.id) || {}).label !== x.label)) {
          out.append(h('button', { class: 'btn accent', html: icon('check'), onclick: () => {
            set({ audio: S.audio.map((a) => { const x = rename.find((y) => y.id === a.id); return x ? { ...a, label: x.label } : a; }) });
            renderMixer();
            startMeters();
            md.close();
            toast('Fuentes renombradas según lo que suena en cada una', 'ok');
          } }, 'Renombrar las fuentes'));
        } else if (rename.length) out.append(h('div', { class: 'hint' }, 'Los nombres de las fuentes ya coinciden con lo que suena en cada una.'));
      } catch (e) {
        out.innerHTML = '';
        out.append(h('div', { class: 'warnbox err', html: icon('alert') }, h('div', null, e.message)));
      } finally {
        md.setLocked(false);
        const go = $('#id-go');
        if (go) go.disabled = false;
      }
    }
  }

  async function calibrate() {
    if (status.running) { toast('Detén el búfer y la grabación antes de calibrar.', 'warn'); return; }
    const md = modal({
      title: 'Calibrar sincronía de audio',
      body: h('div', { class: 'cal-body' },
        h('p', null, 'Aparecerá un cuadrado que parpadea arriba a la izquierda de la pantalla capturada mientras suenan 8 pitidos cortos. Se graba unos segundos y se mide cuánto tarda en llegar el sonido de cada fuente.'),
        h('div', { class: 'warnbox neutral', html: icon('info') }, h('div', null, 'Solo se pueden calibrar las fuentes que reciben el sonido del PC (por ejemplo, las salidas B de Voicemeeter). El micrófono se deja como está.')),
        h('div', { class: 'cal-result', id: 'cal-result' })),
      foot: [h('button', { class: 'btn ghost', onclick: () => md.close() }, 'Cerrar'),
        h('button', { class: 'btn primary', id: 'cal-go', html: icon('target'), onclick: run }, 'Empezar')],
    });
    async function run() {
      const out = $('#cal-result');
      $('#cal-go').disabled = true;
      md.setLocked(true);
      out.innerHTML = '';
      out.append(h('div', { class: 'row' }, h('div', { class: 'spinner' }), 'Calibrando… no muevas esa ventana.'));
      try {
        const res = await unwrap(api.calibrate());
        out.innerHTML = '';
        const ok = res.filter((r) => r.lagMs != null);
        // Un micrófono puede oír los pitidos por los altavoces, pero ese retraso no es el de la voz:
        // por defecto solo se corrigen las fuentes que reciben el sonido del PC directamente.
        const isMic = (r) => /micr|mic\b|headset|auricular|cascos/i.test(`${r.device} ${r.label}`) && !/voicemeeter|stereo mix|mezcla est/i.test(r.device);
        const apply = new Set(ok.filter((r) => !isMic(r)).map((r) => r.id));
        const table = h('div', { class: 'cal-table' }, ...res.map((r) => h('label', { class: 'cal-row' },
          h('span', { class: 'row' }, r.lagMs != null ? h('input', { type: 'checkbox', checked: apply.has(r.id), onchange: (e) => (e.target.checked ? apply.add(r.id) : apply.delete(r.id)) }) : null,
            r.label || r.device),
          h('b', { class: r.lagMs == null ? 'muted' : '' }, r.lagMs == null ? 'sin señal' : `${r.lagMs > 0 ? '+' : ''}${r.lagMs} ms`),
          h('span', { class: 'small muted' }, r.lagMs == null ? 'no recibe el sonido del PC' : isMic(r) ? 'micrófono: oye los altavoces' : r.lagMs > 0 ? 'llega tarde' : 'llega antes'))));
        out.append(table);
        if (ok.length) {
          out.append(h('div', { class: 'hint' }, 'Marca las fuentes a corregir. Los micrófonos quedan sin marcar: su retraso medido incluye el de los altavoces.'));
          out.append(h('button', { class: 'btn accent', html: icon('check'), onclick: () => {
            const audio = S.audio.map((a) => { const r = ok.find((x) => x.id === a.id && apply.has(x.id)); return r ? { ...a, offsetMs: -Math.round(r.lagMs / 5) * 5 } : a; });
            set({ audio });
            renderMixer();
            startMeters();
            md.close();
            toast('Sincronía corregida', 'ok');
          } }, 'Aplicar corrección'));
        } else out.append(h('div', { class: 'warnbox', html: icon('alert') }, h('div', null, 'Ninguna fuente recibió los pitidos. Comprueba que el sonido del PC llegue a alguna de ellas.')));
      } catch (e) {
        out.innerHTML = '';
        out.append(h('div', { class: 'warnbox err', html: icon('alert') }, h('div', null, e.message)));
      } finally {
        md.setLocked(false);
        const go = $('#cal-go');
        if (go) go.disabled = false;
      }
    }
  }

  // ------------------------------------------------------------------ vista previa
  async function updatePreview() {
    const v = $('#cap-preview');
    const off = $('#cap-preview-off');
    if (!v || !S) return;
    const vs = S.video;
    const mon = (devices.monitors || []).find((m) => m.idx === vs.monitor);
    const target = vs.source === 'window' ? (vs.window && vs.window.exe) : [vs.monitor, mon && mon.displayId];
    const key = previewOn && visible ? JSON.stringify([vs.source, target]) : '';
    if (key === previewKey) return;
    previewKey = key;
    stopPreview();
    off.innerHTML = '';
    off.hidden = false;
    if (!key) {
      off.append(h('div', { html: icon(vs.source === 'window' ? 'window' : 'monitor') }), h('div', null, previewOn ? '' : 'Vista previa apagada'));
      return;
    }
    if (vs.source === 'window' && !vs.window) { off.append(h('div', { html: icon('window') }), h('div', null, 'Elige una ventana')); return; }
    if (vs.source === 'window') {
      try {
        ffPreview = true;
        off.append(h('div', { class: 'spinner' }));
        const r = await unwrap(api.ffPreview({ exe: vs.window.exe, title: vs.window.title }));
        // Si entretanto empezó otra vista previa, esa es la que manda.
        if (previewKey !== key) return;
        // Sin imagen al poco rato: lo normal es que la ventana esté minimizada.
        setTimeout(() => {
          if (previewKey !== key || !ffPreview || !$('#cap-preview-img').hidden) return;
          off.innerHTML = '';
          off.append(h('div', { html: icon('window') }), h('div', null, `«${r.name}» no envía imagen (¿está minimizado?). La vista previa aparecerá al volver a la ventana.`));
        }, 2500);
      } catch (e) {
        off.innerHTML = '';
        ffPreview = false;
        off.append(h('div', { html: icon('alert') }), h('div', null, `Sin vista previa: ${e.message}`));
      }
      return;
    }
    try {
      const id = await unwrap(api.previewSource({ kind: vs.source, displayId: mon && mon.displayId, title: vs.window && vs.window.title, exe: vs.window && vs.window.exe }));
      if (!id) throw new Error(vs.source === 'window' ? `«${vs.window.exe.replace(/\.exe$/i, '')}» no está abierto` : 'No se encontró la pantalla');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 } },
      });
      if (previewKey !== key) { stream.getTracks().forEach((t) => t.stop()); return; }
      previewStream = stream;
      v.srcObject = stream;
      off.hidden = true;
    } catch (e) {
      off.append(h('div', { html: icon('alert') }), h('div', null, `Sin vista previa: ${e.message}`));
    }
  }

  function stopPreview() {
    if (previewStream) previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
    if (ffPreview) { ffPreview = false; api.ffPreviewStop(); }
    const img = $('#cap-preview-img');
    if (img) img.hidden = true;
    const v = $('#cap-preview');
    if (v) v.srcObject = null;
  }

  // ------------------------------------------------------------------ panel lateral
  function renderSide() {
    const c = $('#cap-side');
    if (!c || !S) return;
    $$('#cap-side-seg button').forEach((b) => b.classList.toggle('on', b.dataset.t === sideTab));
    c.innerHTML = '';
    if (sideTab === 'clips') renderClips(c);
    else if (sideTab === 'settings') renderSettings(c);
    else if (sideTab === 'stats') renderStats(c);
    else renderVoice(c);
  }

  // Estadísticas en vivo (como el panel de OBS).
  function renderStats(c) {
    const st = status || {};
    const x = st.stats || {};
    const F = S.video.fps;
    const tile = (label, value, { warn = false, hint = '' } = {}) =>
      h('div', { class: `stat-tile${warn ? ' warn' : ''}`, title: hint }, h('div', { class: 'stat-val' }, value), h('div', { class: 'stat-lbl' }, label));
    if (!st.running && !st.reconnecting) {
      c.append(h('div', { class: 'cap-empty-list' }, h('div', { html: icon('chart') }), h('b', null, 'La captura no está en marcha'),
        h('div', { class: 'small muted' }, 'Inicia el búfer o una grabación para ver las estadísticas en vivo.')));
      if (x.diskFree != null) c.append(h('div', { class: 'stat-grid' }, tile('Espacio libre', Core.formatBytes(x.diskFree), { warn: x.diskFree < 5e9 })));
      return;
    }
    const real = st.realFps;
    const mbps = x.bitrate != null ? `${(x.bitrate / 1e6).toFixed(1)} Mb/s` : '—';
    const perMin = x.bitrate != null ? x.bitrate / 8 * 60 : null;
    const left = x.diskFree != null && x.bitrate ? x.diskFree / (x.bitrate / 8) : null;
    c.append(h('div', { class: 'stat-grid' },
      tile('Captura real', real != null ? `${Math.round(real)} / ${F} fps` : `${Math.round(st.fps || 0)} fps`, { warn: real != null && real < F * 0.75, hint: 'Imágenes nuevas por segundo que entrega Windows. Con la pantalla quieta es normal que baje.' }),
      tile('Imágenes repetidas', x.dupPct != null ? `${Math.round(x.dupPct)} %` : '—', { hint: 'Se capturan al doble de los fps de salida: alrededor de un 50 % es lo normal. Más indica que el juego no entrega imágenes nuevas.' }),
      tile('Velocidad del codificador', st.speed ? `${st.speed.toFixed(2)}×` : '—', { warn: st.speed && st.speed < 0.97, hint: 'Por debajo de 1× el codificador no da abasto y se perderían imágenes.' }),
      tile('Bitrate real', mbps, { hint: perMin ? `≈ ${Core.formatBytes(perMin)} por minuto` : '' }),
      tile('CPU del sistema', x.cpu != null ? `${x.cpu} %` : '—', { warn: x.cpu > 90, hint: `${x.cpus} núcleos` }),
      tile('Espacio libre', x.diskFree != null ? Core.formatBytes(x.diskFree) : '—', { warn: x.diskFree != null && x.diskFree < 5e9, hint: left ? `≈ ${fmtClock(left)} de grabación` : '' }),
      tile('Búfer en disco', Core.formatBytes(st.diskBytes || 0)),
      tile('Tiempo activo', fmtClock(x.uptime)),
      tile('Reconexiones (1 min)', String(x.reconnects || 0), { warn: x.reconnects > 2, hint: 'Windows corta la captura al cambiar de resolución o de modo de pantalla; se reconecta sola.' }),
      tile('Prioridad en la GPU', x.gpuPriority ? ({ high: 'Alta', max: 'Máxima', normal: 'Normal' }[S.gpuPriority] || 'Alta') : 'Normal'),
      tile('Modo eficiencia de Windows', x.fullSpeed ? 'Desactivado' : 'Sin cambiar', { hint: 'Windows 11 puede frenar los procesos en segundo plano; la captura se excluye para no recoger las imágenes a destiempo.' })),
      h('div', { class: 'hint' }, `${st.encoder || ''}${st.size ? ` · ${st.size.w}×${st.size.h}` : ''} · ${st.method === 'wgc' ? 'Graphics Capture' : 'Desktop Duplication'}`));
  }

  function renderClips(c) {
    c.append(h('div', { class: 'cap-folder' },
      h('div', { class: 'path-box', title: S.folder }, S.folder),
      h('button', { class: 'btn small', html: icon('folder'), onclick: () => window.api.openPath(S.folder) }, 'Abrir')));
    if (!recent.length) {
      c.append(h('div', { class: 'cap-empty-list' }, h('div', { html: icon('bolt') }),
        h('b', null, 'Aún no hay capturas'),
        h('div', { class: 'small muted' }, `Inicia el búfer y pulsa ${S.hotkeys.clip || 'el atajo'}${S.voice.enabled ? ` o di «${S.voice.phrases[0]}»` : ''} para guardar un clip.`)));
      return;
    }
    const list = h('div', { class: 'cap-list' });
    for (const r of recent) {
      const d = new Date(r.created);
      if (r.kind === 'shot') { list.append(shotItem(r, d)); continue; }
      list.append(h('div', {
        class: 'cap-item', title: r.path,
        ondblclick: () => openInEditor(r.path),
        oncontextmenu: (e) => itemMenu(e, r),
        draggable: true,
        ondragstart: (e) => { e.dataTransfer.setData('text/plain', r.path); },
      },
      h('div', { class: 'cap-thumb', style: r.thumbUrl ? { backgroundImage: `url("${r.thumbUrl}")` } : null },
        h('span', { class: `badge ${r.kind === 'clip' ? 'teal' : 'rec'}` }, r.kind === 'clip' ? 'Clip' : 'Grabación'),
        h('span', { class: 'dur' }, Core.formatTime(r.duration, 0)),
        r.markers && r.markers.length ? h('span', { class: 'marks', title: 'Marcadores (capítulos del vídeo)', html: icon('flag') }, String(r.markers.length)) : null),
      h('div', { class: 'cap-meta' },
        h('div', { class: 'media-name' }, stripExt(baseName(r.path))),
        h('div', { class: 'media-meta' }, `${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)} · ${Core.formatBytes(r.size)}`),
        h('div', { class: 'cap-actions' },
          h('button', { class: 'mini-btn', title: 'Abrir en el editor', html: icon('film'), onclick: () => openInEditor(r.path) }),
          h('button', { class: 'mini-btn', title: 'Añadir a Medios', html: icon('plus'), onclick: () => addToLibrary(r.path, r.kind) }),
          h('button', { class: 'mini-btn', title: 'Mostrar en la carpeta', html: icon('folder'), onclick: () => window.api.showItem(r.path) }),
          h('button', { class: 'mini-btn', title: 'Más opciones', html: icon('sliders'), onclick: (e) => itemMenu(e, r) })))));
    }
    c.append(list);
  }

  function shotItem(r, d) {
    return h('div', { class: 'cap-item', title: r.path, ondblclick: () => window.api.openPath(r.path), oncontextmenu: (e) => shotMenu(e, r) },
      h('div', { class: 'cap-thumb', style: r.thumbUrl ? { backgroundImage: `url("${r.thumbUrl}")` } : null },
        h('span', { class: 'badge shot' }, 'Imagen')),
      h('div', { class: 'cap-meta' },
        h('div', { class: 'media-name' }, stripExt(baseName(r.path))),
        h('div', { class: 'media-meta' }, `${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)} · ${Core.formatBytes(r.size)}`),
        h('div', { class: 'cap-actions' },
          h('button', { class: 'mini-btn', title: 'Abrir', html: icon('image'), onclick: () => window.api.openPath(r.path) }),
          h('button', { class: 'mini-btn', title: 'Mostrar en la carpeta', html: icon('folder'), onclick: () => window.api.showItem(r.path) }),
          h('button', { class: 'mini-btn', title: 'Más opciones', html: icon('sliders'), onclick: (e) => shotMenu(e, r) }))));
  }

  function shotMenu(e, r) {
    contextMenu(e, [
      { header: baseName(r.path) },
      { label: 'Abrir', icon: 'image', action: () => window.api.openPath(r.path) },
      { label: 'Mostrar en la carpeta', icon: 'folder', action: () => window.api.showItem(r.path) },
      'sep',
      { label: 'Quitar de la lista', icon: 'x', action: async () => { recent = await unwrap(api.forgetRecent(r.path)); renderSide(); } },
    ]);
  }

  function itemMenu(e, r) {
    contextMenu(e, [
      { header: baseName(r.path) },
      { label: 'Abrir en el editor', icon: 'film', action: () => openInEditor(r.path) },
      { label: 'Añadir a Medios', icon: 'plus', action: () => addToLibrary(r.path, r.kind) },
      { label: 'Exportar fuentes…', icon: 'layers', action: () => withInfo(r.path, (info) => X.exportSources(r.path, info)) },
      { label: 'Estirar a 1920×1080 (16:9)', icon: 'maximize', action: () => withInfo(r.path, (info) => X.stretch(r.path, info)) },
      { label: 'Recortar el audio en el Cortador', icon: 'scissors', action: () => { App.showView('cutter'); App.cutter.load(r.path); } },
      'sep',
      { label: 'Mostrar en la carpeta', icon: 'folder', action: () => window.api.showItem(r.path) },
      { label: 'Quitar de la lista', icon: 'x', action: async () => { recent = await unwrap(api.forgetRecent(r.path)); renderSide(); } },
    ]);
  }

  async function withInfo(p, fn) {
    try { fn(await window.api.probe(p)); } catch (e) { toast(cleanIpcError(e.message), 'err'); }
  }

  async function addToLibrary(p, kind, { quiet } = {}) {
    const ids = await App.library.importPaths([p], { quiet });
    ids.forEach((id) => { const m = App.store.get(id); if (m) m.capture = kind || 'clip'; });
    App.library.render();
    return ids;
  }

  async function openInEditor(p) {
    const ids = await addToLibrary(p, null, { quiet: true });
    App.showView('editor');
    if (ids.length) App.addClips(ids);
  }

  X.isCapture = (p) => !!S && !!S.folder && String(p).toLowerCase().startsWith(S.folder.toLowerCase() + '\\');

  // ---- ajustes
  function section(title, ic, ...body) {
    return h('div', { class: 'cap-sec' }, h('div', { class: 'cap-sec-head', html: icon(ic) }, h('span', null, title)), h('div', { class: 'cap-sec-body' }, ...body));
  }

  // Bitrate en Mb/s (con bitrate variable o constante), con el tamaño aproximado por minuto.
  function brSlider() {
    const lbl = (v) => `${v} Mb/s · ≈ ${Core.formatBytes(v * 1e6 / 8 * 60)}/min`;
    const val = h('span', { class: 'val' }, lbl(S.bitrate || 40));
    const r = h('input', { type: 'range', min: 6, max: 120, step: 2, value: S.bitrate || 40,
      oninput: (e) => { val.textContent = lbl(Number(e.target.value)); set({ bitrate: Number(e.target.value) }, { debounce: 400 }); } });
    requestAnimationFrame(() => paintRange(r));
    return h('div', { class: 'slider' }, h('span', { class: 'lbl' }, 'Bitrate'), val, r);
  }

  // Tamaño aproximado del búfer en disco (con el bitrate real si la captura está en marcha).
  function bufferBytes(sec) {
    const br = status.stats && status.stats.bitrate;
    const bps = br || ((S.rate || 'cqp') === 'cqp' ? 30e6 : (S.bitrate || 40) * 1e6);
    return (bps / 8) * sec;
  }

  // ---- tu equipo (adaptación automática)
  let sysData = null, sysLoading = false;
  function systemSection() {
    if (!sysData) {
      if (!sysLoading) {
        sysLoading = true;
        unwrap(api.system()).then((d) => { sysData = d; if (sideTab === 'settings') renderSide(); }).catch(() => {}).finally(() => { sysLoading = false; });
      }
      return section('Tu equipo', 'gpu', h('div', { class: 'hint' }, 'Detectando tarjeta gráfica, procesador y pantallas…'));
    }
    const { info, rec, ffmpeg, caps: fc } = sysData;
    const line = (k, v) => h('div', { class: 'sys-row' }, h('span', { class: 'muted' }, k), h('span', null, v));
    const encs = fc.encoders.filter((e) => e.id !== 'x264');
    return section('Tu equipo', 'gpu',
      ...(info.gpus.length ? info.gpus : [{ name: 'No detectada', vendorLabel: '', integrated: false }]).map((g, i) =>
        line(i ? '' : `Gráfica${info.gpus.length > 1 ? 's' : ''}`, `${g.name}${g.vendorLabel ? ` · ${g.integrated ? 'integrada' : 'dedicada'}` : ''}`)),
      line('Procesador', `${info.cpu.model} · ${info.cpu.threads} hilos`),
      line('Memoria', `${info.ramGB} GB`),
      line(`Pantalla${info.displays.length > 1 ? 's' : ''}`, info.displays.map((d) => `${d.w}×${d.h} a ${d.hz} Hz`).join(' · ') || '—'),
      line('Codificadores', encs.length ? encs.map((e) => `${e.label} (${[e.h264 && 'H.264', e.hevc && 'HEVC'].filter(Boolean).join(', ')})`).join(' · ') : 'Solo CPU (x264)'),
      line('FFmpeg', `${ffmpeg.source} · ${String(ffmpeg.version).split('-').slice(0, 3).join('-')}`),
      ...rec.notes.map((n) => h('div', { class: 'hint' }, n)),
      ffmpeg.source !== 'incluido' && !fc.vppAmf && !fc.scaleD3d11 ? h('div', { class: 'warnbox', html: icon('alert') }, h('div', null, 'Este FFmpeg no convierte la imagen en la GPU: la captura irá más lenta. Usa el instalador oficial de Fotograma Studio, que incluye uno moderno.')) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn small accent', html: icon('sparkle'), onclick: async () => {
          try {
            const r = await unwrap(api.autoConfig());
            S = r.settings;
            renderAll();
            toast(`Configurado para tu equipo: ${rec.encoder === 'x264' ? 'CPU' : (encs.find((e) => e.id === rec.encoder) || {}).label || rec.encoder} · ${S.video.fps} fps`, 'ok', 3500);
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Configurar según mi equipo'),
        h('button', { class: 'btn small ghost', html: icon('bolt'), title: 'Prueba los métodos de captura con el juego en marcha y aplica el más fluido', onclick: optimize }, 'Optimizar fluidez')));
  }

  function renderSettings(c) {
    const qLabel = (q) => (q <= 16 ? 'Máxima' : q <= 20 ? 'Alta' : q <= 25 ? 'Equilibrada' : 'Ligera');
    const qVal = h('span', { class: 'val' }, `${qLabel(S.quality)} · ${S.quality}`);
    const q = h('input', { type: 'range', min: 14, max: 32, step: 1, value: 46 - S.quality,
      oninput: (e) => { const v = 46 - Number(e.target.value); qVal.textContent = `${qLabel(v)} · ${v}`; set({ quality: v }, { debounce: 400 }); } });
    const post = h('input', { type: 'range', min: 0, max: 10, step: 1, value: S.postRollSec,
      oninput: (e) => { postVal.textContent = `${e.target.value} s`; set({ postRollSec: Number(e.target.value) }, { debounce: 300 }); } });
    const postVal = h('span', { class: 'val' }, `${S.postRollSec} s`);
    requestAnimationFrame(() => { paintRange(q); paintRange(post); });
    const encs = caps ? caps.encoders : [];
    const encSel = h('select', { onchange: (e) => set({ encoder: e.target.value }) },
      h('option', { value: 'auto', selected: S.encoder === 'auto' }, 'Automático (GPU si es posible)'),
      ...encs.map((e) => h('option', { value: e.id, selected: S.encoder === e.id }, e.label)));
    const enc = encs.find((e) => e.id === S.encoder) || encs.find((e) => e.id !== 'x264') || encs[0];

    c.append(
      systemSection(),
      section('Búfer y clips', 'loop',
        h('div', { class: 'field' }, h('span', null, 'Duración del clip (búfer)'),
          h('div', { class: 'chips' }, ...[15, 30, 45, 60, 120, 300].map((s) =>
            h('button', { class: `chip mono${S.bufferSec === s ? ' on' : ''}`, onclick: () => setBuffer(s) }, s < 60 ? `${s} s` : `${s / 60} min`))),
          h('div', { class: 'row cap-buf-row' }, h('span', { class: 'small muted' }, 'Personalizado'),
            h('input', { type: 'number', id: 'cap-buf-custom', min: 5, max: 1800, step: 1, value: S.bufferSec, onchange: (e) => setBuffer(e.target.value) }),
            h('span', { class: 'small muted' }, 'segundos (5 a 1800)')),
          h('div', { class: 'hint' }, `Ocupa ≈ ${Core.formatBytes(bufferBytes(S.bufferSec))} en el disco temporal mientras el búfer está activo. Se cambia al momento, sin reiniciar la captura.`)),
        h('div', { class: 'field' }, h('span', null, 'Clip corto (segundo atajo)'),
          h('div', { class: 'chips' }, ...[10, 15, 20, 30].map((s) =>
            h('button', { class: `chip mono${S.clipShortSec === s ? ' on' : ''}`, onclick: () => { set({ clipShortSec: s }); renderSide(); } }, `${s} s`)))),
        h('div', { class: 'slider' }, h('span', { class: 'lbl' }, 'Seguir grabando tras el aviso'), postVal, post),
        h('div', { class: 'hint' }, 'Útil con la voz: el clip incluye también lo que pasa justo después de pedirlo.'),
        h('div', { class: 'field' }, h('span', null, 'Carpeta'),
          h('div', { class: 'row' }, h('div', { class: 'path-box', title: S.folder }, S.folder),
            h('button', { class: 'btn small', onclick: async () => {
              const p = await window.api.pickFolder({ title: 'Carpeta para clips y grabaciones', defaultPath: S.folder });
              if (p) { await set({ folder: p }); renderSide(); }
            } }, 'Cambiar'))),
        h('div', { class: 'field' }, h('span', null, 'Formato'),
          h('div', { class: 'seg block' }, ...[['mp4', 'MP4'], ['mkv', 'MKV'], ['mov', 'MOV']].map(([id, l]) =>
            h('button', { class: S.container === id ? 'on' : '', onclick: () => { set({ container: id }); renderSide(); } }, l)))),
        h('div', { class: 'field' }, h('span', null, 'Dividir las grabaciones largas'),
          h('div', { class: 'chips' }, ...[[0, 'No'], [15, '15 min'], [30, '30 min'], [60, '1 h']].map(([m, l]) =>
            h('button', { class: `chip${(S.splitMin || 0) === m ? ' on' : ''}`, onclick: () => { set({ splitMin: m }); renderSide(); } }, l))),
          h('div', { class: 'hint' }, 'Guarda un archivo cada cierto tiempo y sigue grabando en otro, sin cortes.')),
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', class: 'switch', checked: S.addToLibrary, onchange: (e) => set({ addToLibrary: e.target.checked }) }), 'Añadir cada captura a Medios'),
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', class: 'switch', checked: S.sound, onchange: (e) => set({ sound: e.target.checked }) }), 'Sonido al guardar un clip')),
      section('Codificación', 'gpu',
        h('div', { class: 'field' }, h('span', null, 'Codificador'), encSel),
        h('div', { class: 'field' }, h('span', null, 'Códec'),
          h('div', { class: 'seg block' }, ...[['h264', 'H.264 (compatible)'], ['hevc', 'HEVC (más ligero)']].map(([id, l]) =>
            h('button', { class: S.codec === id ? 'on' : '', disabled: id === 'hevc' && enc && !enc.hevc && S.encoder !== 'auto', onclick: () => { set({ codec: id }); renderSide(); } }, l)))),
        h('div', { class: 'field' }, h('span', null, 'Control de tasa'),
          h('div', { class: 'seg block' }, ...[['cqp', 'Calidad constante'], ['vbr', 'Bitrate variable'], ['cbr', 'Bitrate constante']].map(([id, l]) =>
            h('button', { class: (S.rate || 'cqp') === id ? 'on' : '', onclick: () => { set({ rate: id }); renderSide(); } }, l)))),
        (S.rate || 'cqp') === 'cqp' ? h('div', { class: 'slider' }, h('span', { class: 'lbl' }, 'Calidad'), qVal, q) : brSlider(),
        h('div', { class: 'field' }, h('span', null, 'Preajuste del codificador'),
          h('div', { class: 'seg block' }, ...[['speed', 'Velocidad'], ['balanced', 'Equilibrado'], ['quality', 'Calidad']].map(([id, l]) =>
            h('button', { class: (S.preset || 'balanced') === id ? 'on' : '', onclick: () => { set({ preset: id }); renderSide(); } }, l))),
          h('div', { class: 'hint' }, 'Equilibrado es el que se midió en partida a 60 fps reales. «Calidad» exige más a la tarjeta; «Velocidad» deja más margen al juego.')),
        h('div', { class: 'field' }, h('span', null, 'Prioridad de la captura en la GPU'),
          h('div', { class: 'seg block' }, ...[['normal', 'Normal'], ['high', 'Alta'], ['max', 'Máxima']].map(([id, l]) =>
            h('button', { class: (S.gpuPriority || 'high') === id ? 'on' : '', onclick: () => { set({ gpuPriority: id }); renderSide(); } }, l))),
          h('div', { class: 'hint' }, 'Si el juego usa la tarjeta al 100 %, la captura puede quedarse sin imágenes y el clip verse a saltos. «Alta» lo evita (como OBS); usa «Máxima» si aún va a tirones.')),
        h('div', { class: 'cols' },
          h('div', { class: 'field' }, h('span', null, 'Códec de audio'),
            h('div', { class: 'seg block' }, ...[['aac', 'AAC'], ['opus', 'Opus']].map(([id, l]) =>
              h('button', { class: (S.audioCodec || 'aac') === id ? 'on' : '', title: id === 'opus' ? 'Más calidad por kbps; algunos programas antiguos no lo abren' : 'Compatible con todo', onclick: () => { set({ audioCodec: id }); renderSide(); } }, l)))),
          h('div', { class: 'field' }, h('span', null, 'Bitrate por pista'),
            h('select', { onchange: (e) => set({ audioKbps: Number(e.target.value) }) },
              ...[96, 128, 160, 192, 256, 320].map((k) => h('option', { value: String(k), selected: S.audioKbps === k }, `${k} kbps`))))),
        h('div', { class: 'hint' }, 'La captura y la codificación van por la GPU, así el juego conserva sus fotogramas. Calidad constante reparte los bits según la escena; con bitrate el tamaño del archivo es previsible.')),
      section('Atajos globales', 'keyboard',
        hotkeyField('clip', 'Guardar clip'),
        hotkeyField('clipShort', `Guardar clip corto (${S.clipShortSec} s)`),
        hotkeyField('record', 'Iniciar / detener grabación'),
        hotkeyField('pause', 'Pausar / reanudar grabación'),
        hotkeyField('buffer', 'Iniciar / detener búfer'),
        hotkeyField('mark', 'Poner marcador'),
        hotkeyField('screenshot', 'Captura de pantalla'),
        hotkeyField('muteMic', 'Silenciar / activar micrófono'),
        h('div', { class: 'hint' }, 'Funcionan aunque estés dentro del juego. Haz clic en un campo y pulsa la combinación; Retroceso lo borra.')),
      section('General', 'gear',
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', class: 'switch', checked: S.autoStartBuffer, onchange: (e) => set({ autoStartBuffer: e.target.checked }) }), 'Iniciar el búfer al abrir la aplicación'),
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', class: 'switch', checked: S.closeToTray, onchange: (e) => set({ closeToTray: e.target.checked }) }), 'Al cerrar mientras captura, seguir en la bandeja')));
  }

  function hotkeyField(action, label) {
    const err = hotkeyErrors[action];
    const val = S.hotkeys[action] || '';
    const box = h('button', { class: `hotkey${err ? ' err' : ''}`, title: err || 'Haz clic y pulsa una combinación' }, val || 'Sin asignar');
    box.addEventListener('click', () => {
      box.classList.add('listening');
      box.textContent = 'Pulsa una combinación…';
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') return done(null);
        if (e.key === 'Backspace' || e.key === 'Delete') return done('');
        const acc = accelerator(e);
        if (acc) done(acc);
      };
      const done = async (acc) => {
        document.removeEventListener('keydown', onKey, true);
        box.removeEventListener('blur', cancel);
        box.classList.remove('listening');
        if (acc !== null) await set({ hotkeys: { ...S.hotkeys, [action]: acc } });
        renderSide();
        renderControls();
      };
      const cancel = () => done(null);
      document.addEventListener('keydown', onKey, true);
      box.addEventListener('blur', cancel);
    });
    return h('div', { class: 'hk-row' }, h('span', null, label), box, err ? h('span', { class: 'hk-err small' }, err) : null);
  }

  // Convierte un evento de teclado en un acelerador de Electron (p. ej. "Ctrl+Shift+F8").
  function accelerator(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const code = e.code || '';
    let key = null;
    if (/^F\d{1,2}$/.test(code)) key = code;
    else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit\d$/.test(code)) key = code.slice(5);
    else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`;
    else {
      key = { Space: 'Space', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Pause: 'Pause', ScrollLock: 'Scrolllock',
        ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
        NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', Backquote: '`', Minus: '-', Equal: '=' }[code] || null;
    }
    if (!key) return null;
    // Las letras y números sueltos se usan al jugar: exigen un modificador.
    if (!mods.length && /^([A-Z0-9]|Space|`|-|=|Up|Down|Left|Right)$/.test(key)) { toast('Añade Ctrl, Alt o Mayús a esa tecla (se usa al jugar).', 'warn'); return null; }
    return [...mods, key].join('+');
  }

  // ---- voz
  function renderVoice(c) {
    const v = S.voice;
    const models = voice.models || {};
    const m = models[v.lang] || {};
    const st = voice.state;
    const stText = { listening: 'Escuchando', loading: 'Cargando el modelo…', nomodel: 'Falta descargar el modelo', error: 'Error', off: 'Desactivado' }[v.enabled ? st : 'off'] || st;
    const phraseInput = h('input', { type: 'text', placeholder: 'Añadir frase y Enter', class: 'phrase-input', onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      const p = e.target.value.trim().toLowerCase();
      if (!p) return;
      if (!v.phrases.includes(p)) set({ voice: { ...v, phrases: [...v.phrases, p] } }).then(renderSide);
      e.target.value = '';
    } });
    const cd = h('input', { type: 'range', min: 1, max: 15, step: 1, value: v.cooldown,
      oninput: (e) => { cdVal.textContent = `${e.target.value} s`; set({ voice: { ...S.voice, cooldown: Number(e.target.value) } }, { debounce: 400 }); } });
    const cdVal = h('span', { class: 'val' }, `${v.cooldown} s`);
    requestAnimationFrame(() => paintRange(cd));
    const mics = [...new Set([...(voiceDevices || []), ...(v.device ? [v.device] : [])])];
    const examples = v.lang === 'en' ? ['clip that', 'save that', 'clip it'] : ['guarda eso', 'graba eso', 'qué jugada'];

    c.append(
      h('div', { class: 'voice-hero' },
        h('label', { class: 'check-row big' }, h('input', { type: 'checkbox', class: 'switch', checked: v.enabled, onchange: (e) => set({ voice: { ...S.voice, enabled: e.target.checked } }).then(renderSide) }),
          h('div', null, h('b', null, 'Guardar clips con la voz'), h('div', { class: 'small muted' }, 'Como «Medal, clip that», pero con tus propias frases y sin conexión.'))),
        v.enabled ? h('div', { class: `voice-status ${st}` }, h('span', { class: 'vdot', style: { '--lv': String(Math.min(1, voiceLevel * 2.5)) } }), stText,
          voice.device ? h('span', { class: 'small muted' }, ` · ${voice.device}`) : null) : null,
        st === 'error' && voice.message ? h('div', { class: 'warnbox err', html: icon('alert') }, h('div', null, voice.message)) : null),
      section('Idioma y modelo', 'wave',
        h('div', { class: 'seg block' }, ...[['es', 'Español'], ['en', 'Inglés']].map(([id, l]) =>
          h('button', { class: v.lang === id ? 'on' : '', onclick: () => set({ voice: { ...S.voice, lang: id, phrases: S.voice.lang === id ? S.voice.phrases : (id === 'en' ? ['clip that', 'save that'] : ['guarda eso', 'graba eso']) } }).then(renderSide) },
            l, models[id] && models[id].installed ? ' ✓' : ''))),
        m.installed ? h('div', { class: 'hint' }, `Modelo instalado (${Core.formatBytes(m.size)}). Funciona sin internet.`)
          : downloadPct[v.lang] != null ? h('div', { class: 'field' }, h('span', null, `Descargando… ${Math.round(downloadPct[v.lang] * 100)}%`),
            h('div', { class: 'pbar' }, h('div', { style: { width: `${downloadPct[v.lang] * 100}%` } })))
            : h('button', { class: 'btn accent', html: icon('import'), onclick: () => downloadModel(v.lang) }, `Descargar modelo (${Core.formatBytes(m.size || 0)})`)),
      section('Frases que guardan un clip', 'mic',
        h('div', { class: 'chips phrase-chips' }, ...v.phrases.map((p) => h('span', { class: 'chip on phrase' }, p,
          h('button', { title: 'Quitar', html: icon('x'), onclick: () => set({ voice: { ...v, phrases: v.phrases.filter((x) => x !== p) } }).then(renderSide) })))),
        phraseInput,
        h('div', { class: 'hint' }, 'Usa 2 o 3 palabras que no digas al jugar. Sugerencias: ',
          ...examples.filter((x) => !v.phrases.includes(x)).map((x) => h('button', { class: 'link', onclick: () => set({ voice: { ...v, phrases: [...v.phrases, x] } }).then(renderSide) }, x)))),
      section('Micrófono', 'headphones',
        h('select', { onchange: (e) => set({ voice: { ...S.voice, device: e.target.value } }) },
          h('option', { value: '' }, 'Predeterminado de Windows'),
          ...mics.map((l) => h('option', { value: l, selected: l === v.device }, l))),
        h('div', { class: 'slider' }, h('span', { class: 'lbl' }, 'Espera entre clips'), cdVal, cd),
        h('div', { class: 'hint' }, 'Elige tu micrófono directo (no una salida con el sonido del juego), así no se activa con la voz de otros.')),
      section('Probar', 'eye',
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', class: 'switch', checked: !!voice.test, onchange: (e) => { voice.test = e.target.checked; api.voiceTest(e.target.checked); } }),
          'Mostrar todo lo que reconoce'),
        h('div', { class: 'voice-heard', id: 'voice-heard' }, voiceHeard || (v.enabled ? 'Habla para probar…' : 'Activa la voz para probar')),
        h('div', { class: 'hint' }, 'En modo prueba reconoce frases libres (menos preciso). Desactívalo al jugar para la máxima precisión.')));
  }

  async function downloadModel(lang) {
    downloadPct[lang] = 0;
    renderSide();
    try {
      const st = await unwrap(api.voiceDownload(lang));
      voice = { ...voice, ...st.voice };
      toast('Modelo de voz instalado', 'ok');
    } catch (e) { toast(`No se pudo descargar: ${e.message}`, 'err', 7000); }
    delete downloadPct[lang];
    renderSide();
    renderControls();
  }

  // ------------------------------------------------------------------ eventos
  function chime(kind) {
    if (!S || !S.sound) return;
    try {
      const ctx = chime.ctx || (chime.ctx = new AudioContext());
      const t = ctx.currentTime + 0.01;
      const notes = { start: [880], err: [330, 247], mark: [1175], shot: [1320, 1320], micOn: [523, 784], micOff: [784, 523] }[kind] || [660, 990];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        const t0 = t + i * 0.09;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.18, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
        o.connect(g).connect(ctx.destination);
        o.start(t0);
        o.stop(t0 + 0.25);
      });
    } catch { /* ignorar */ }
  }

  function onEvent(e) {
    if (e.type === 'clip-start') { chime('start'); toast(`Guardando clip de ${e.seconds} s…`, 'info', 1600); return; }
    if (e.type === 'clip-saved' || e.type === 'recording-saved') {
      if (e.type === 'clip-saved') chime('ok');
      recent = [e.item, ...recent.filter((r) => r.path !== e.item.path)];
      if (sideTab === 'clips') renderSide();
      const name = baseName(e.item.path);
      toast(`${e.type === 'clip-saved' ? 'Clip guardado' : 'Grabación guardada'}: ${name}`, 'ok', 3500);
      if (S.addToLibrary) addToLibrary(e.item.path, e.type === 'clip-saved' ? 'clip' : 'recording', { quiet: true });
      return;
    }
    if (e.type === 'shot-saved') {
      chime('shot');
      recent = [e.item, ...recent.filter((r) => r.path !== e.item.path)];
      if (sideTab === 'clips') renderSide();
      toast(`Captura de pantalla guardada: ${baseName(e.item.path)}`, 'ok', 3000);
      return;
    }
    if (e.type === 'mark') { chime('mark'); toast(`Marcador ${e.n} puesto`, 'info', 1500); return; }
    if (e.type === 'mic') {
      chime(e.muted ? 'micOff' : 'micOn');
      S.audio = e.audio;
      renderMixer();
      startMeters();
      toast(e.muted ? 'Micrófono silenciado' : 'Micrófono activado', e.muted ? 'warn' : 'ok', 1800);
      return;
    }
    if (e.type === 'error') { chime('err'); toast(e.message, 'err', 8000); return; }
    if (e.type === 'warn') toast(e.message, 'warn', 4000);
    if (e.type === 'info') toast(e.message, 'info', 5000);
  }

  function onVoice(d) {
    if (d.type === 'status') {
      voice = { ...voice, ...d };
      renderControls();
      if (sideTab === 'voice') renderSide();
    } else if (d.type === 'level') {
      voiceLevel = d.level;
      $$('.vdot').forEach((el) => el.style.setProperty('--lv', String(Math.min(1, voiceLevel * 2.5))));
    } else if (d.type === 'heard') {
      voiceHeard = d.text;
      const el = $('#voice-heard');
      if (el) el.textContent = d.text;
    } else if (d.type === 'devices') {
      voiceDevices = [...new Set([...voiceDevices, ...d.devices])];
    } else if (d.type === 'download') {
      if (d.pct >= 1) {
        delete downloadPct[d.lang];
        unwrap(api.state()).then((st) => { voice = { ...voice, ...st.voice }; S = st.settings; renderControls(); if (sideTab === 'voice') renderSide(); }).catch(() => {});
        return;
      }
      downloadPct[d.lang] = d.pct;
      if (sideTab === 'voice') {
        const lbl = $('#cap-side .pbar');
        if (lbl) { lbl.firstChild.style.width = `${d.pct * 100}%`; lbl.previousSibling.textContent = `Descargando… ${Math.round(d.pct * 100)}%`; } else renderSide();
      }
    } else if (d.type === 'trigger') {
      const chip = $('.cap-voice-chip');
      if (chip) { chip.classList.add('fired'); setTimeout(() => chip.classList.remove('fired'), 1200); }
    }
  }

  // ------------------------------------------------------------------ visibilidad
  X.onShow = function () {
    visible = true;
    updatePreview();
    startMeters();
    refreshWindows();
    clearInterval(winTimer);
    winTimer = setInterval(refreshWindows, 3000);
  };
  X.onHide = function () {
    visible = false;
    clearInterval(winTimer);
    previewKey = null;
    stopPreview();
    stopMeters();
  };

  // ------------------------------------------------------------------ fuentes de una grabación
  /* Exporta por separado las pistas (micrófono, juego, Discord…) y/o el vídeo sin audio. */
  X.exportSources = function (p, info) {
    const tracks = info.audioTracks && info.audioTracks.length ? info.audioTracks : (info.hasAudio ? [{ i: 0, name: 'Audio', codec: info.acodec }] : []);
    if (!tracks.length) { toast('Este vídeo no tiene audio.', 'warn'); return; }
    const multi = tracks.length > 1;
    const sel = new Set(tracks.filter((t) => !(multi && t.i === 0 && /mezcla/i.test(t.name))).map((t) => t.i));
    if (!sel.size) tracks.forEach((t) => sel.add(t.i));
    let withVideo = false;
    let format = 'wav';
    let kbps = 256;
    let outDir = `${dirName(p)}\\${stripExt(baseName(p))} - fuentes`;
    const fmtSel = h('select', { onchange: (e) => { format = e.target.value; kb.disabled = !(Core.AUDIO_FORMATS.find((f) => f.id === format) || {}).kbps; } },
      ...Core.AUDIO_FORMATS.map((f) => h('option', { value: f.id, selected: f.id === format }, f.id === 'original' ? 'Original (copia sin recodificar)' : f.label)));
    const kb = h('select', { disabled: true, onchange: (e) => (kbps = Number(e.target.value)) }, ...[128, 192, 256, 320].map((k) => h('option', { value: String(k), selected: k === kbps }, `${k} kbps`)));
    const dirBox = h('div', { class: 'path-box', title: outDir }, outDir);
    const body = h('div', { class: 'src-export' },
      h('div', { class: 'subhead' }, `Pistas de «${baseName(p)}»`),
      h('div', { class: 'src-list' }, ...tracks.map((t) => h('label', { class: 'check-row src-row' },
        h('input', { type: 'checkbox', checked: sel.has(t.i), onchange: (e) => (e.target.checked ? sel.add(t.i) : sel.delete(t.i)) }),
        h('span', { html: icon(/mezcla/i.test(t.name) ? 'layers' : /mic/i.test(t.name) ? 'mic' : 'volume') }),
        h('b', null, t.name), h('span', { class: 'small muted' }, `pista ${t.i + 1} · ${(t.codec || '').toUpperCase()}${t.channels === 1 ? ' · mono' : ''}`))),
      info.kind !== 'audio' ? h('label', { class: 'check-row src-row' },
        h('input', { type: 'checkbox', onchange: (e) => (withVideo = e.target.checked) }), h('span', { html: icon('film') }), h('b', null, 'Vídeo sin audio'), h('span', { class: 'small muted' }, 'copia directa')) : null),
      h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('span', null, 'Formato de audio'), fmtSel), h('div', { class: 'field' }, h('span', null, 'Calidad'), kb)),
      h('div', { class: 'field' }, h('span', null, 'Carpeta de destino'),
        h('div', { class: 'row' }, dirBox, h('button', { class: 'btn small', onclick: async () => {
          const d = await window.api.pickFolder({ title: 'Carpeta de destino', defaultPath: dirName(p) });
          if (d) { outDir = d; dirBox.textContent = d; dirBox.title = d; }
        } }, 'Cambiar'))),
      h('div', { id: 'src-progress' }));
    const md = modal({
      title: 'Exportar fuentes',
      body,
      foot: [h('button', { class: 'btn ghost', onclick: () => md.close() }, 'Cancelar'),
        h('button', { class: 'btn primary', id: 'src-go', html: icon('export'), onclick: go }, 'Exportar')],
    });
    async function go() {
      const chosen = tracks.filter((t) => sel.has(t.i));
      if (!chosen.length && !withVideo) { toast('Elige al menos una pista.', 'warn'); return; }
      const id = uid('job');
      const prog = $('#src-progress');
      prog.innerHTML = '';
      const bar = h('div', { class: 'pbar' }, h('div', { style: { width: '0%' } }));
      prog.append(bar);
      $('#src-go').disabled = true;
      md.setLocked(true);
      const off = window.api.onJobProgress((pr) => { if (pr.id === id) bar.firstChild.style.width = `${(pr.overall || 0) * 100}%`; });
      const r = await window.api.exportTracks({ id, input: p, outDir, baseName: stripExt(baseName(p)), tracks: chosen, video: withVideo, format, kbps, duration: info.duration });
      off();
      md.setLocked(false);
      if (!r.ok) { prog.innerHTML = ''; prog.append(h('div', { class: 'warnbox err', html: icon('alert') }, h('div', null, r.error))); $('#src-go').disabled = false; return; }
      md.close();
      toast(`${r.paths.length} archivo${r.paths.length > 1 ? 's' : ''} exportado${r.paths.length > 1 ? 's' : ''}`, 'ok');
      const done = modal({
        title: 'Fuentes exportadas',
        body: h('div', { class: 'src-done' }, ...r.paths.map((f) => h('div', { class: 'path-box' }, baseName(f)))),
        foot: [
          h('button', { class: 'btn ghost', onclick: () => { window.api.showItem(r.paths[0]); } , html: icon('folder') }, 'Mostrar en la carpeta'),
          h('button', { class: 'btn primary', html: icon('plus'), onclick: () => { App.library.importPaths(r.paths); done.close(); } }, 'Añadir a Medios'),
        ],
      });
    }
  };

  /* Separa las pistas de una grabación en la línea de tiempo: vídeo + una pista de audio por fuente. */
  X.splitToEditor = async function (m) {
    const info = m.info;
    const tracks = (info.audioTracks || []).filter((t) => !(t.i === 0 && /mezcla/i.test(t.name)));
    if (!tracks.length) return;
    const id = uid('job');
    toast('Separando las pistas…', 'info', 2000);
    const r = await window.api.exportTracks({
      id, input: m.path, outDir: `${S.folder}\\Fuentes`, baseName: stripExt(m.name), tracks, video: false, format: 'original', duration: info.duration,
    });
    if (!r.ok) { toast(r.error, 'err'); return; }
    const ids = await App.library.importPaths(r.paths, { quiet: true });
    const { state, store } = App;
    const start = Core.sequenceLayout(state.clips).total;
    const clip = App.createClip(m);
    clip.muted = true;
    state.clips.push(clip);
    ids.forEach((aid, k) => {
      const am = store.get(aid);
      if (!am) return;
      const t = App.newTrack(tracks[k] ? tracks[k].name : undefined);
      state.tracks.push(t);
      state.audioClips.push(App.createAudioClip(am, { trackId: t.id, start }));
    });
    state.selectedId = clip.id;
    state.selKind = 'video';
    App.commit();
    App.showView('editor');
    toast(`Vídeo y ${ids.length} pistas añadidos; el audio original del clip queda silenciado.`, 'ok', 4000);
  };

  /* Estira a 1920×1080 (16:9), igual que escalador.bat. */
  X.stretch = async function (p, info) {
    if (info.width === 1920 && info.height === 1080) { toast('El vídeo ya es 1920×1080.', 'info'); return; }
    const id = uid('job');
    const t = h('div', { class: 'pbar' }, h('div', { style: { width: '0%' } }));
    const md = modal({ title: 'Estirando a 1920×1080', body: h('div', { class: 'field' }, h('span', null, `${baseName(p)} · ${info.width}×${info.height} → 1920×1080`), t),
      foot: [h('button', { class: 'btn ghost', onclick: () => window.api.cancelJob(id) }, 'Cancelar')] });
    md.setLocked(true);
    const off = window.api.onJobProgress((pr) => { if (pr.id === id) t.firstChild.style.width = `${(pr.overall || 0) * 100}%`; });
    const r = await window.api.stretchVideo({ id, input: p, duration: info.duration });
    off();
    md.setLocked(false);
    md.close();
    if (!r.ok) { if (!r.cancelled) toast(r.error, 'err'); return; }
    toast(`Listo: ${baseName(r.path)}`, 'ok');
    App.library.importPaths([r.path], { quiet: true });
  };
})();
