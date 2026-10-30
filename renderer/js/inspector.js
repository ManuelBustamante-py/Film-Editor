/* Inspector: propiedades del clip seleccionado. */
(function () {
  const App = window.App;
  const { state } = App;
  const I = (App.inspector = {});
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const CROP_ASPECTS = [
    { id: 'free', label: 'Libre', r: null },
    { id: '16:9', label: '16:9', r: 16 / 9 },
    { id: '9:16', label: '9:16', r: 9 / 16 },
    { id: '1:1', label: '1:1', r: 1 },
    { id: '4:3', label: '4:3', r: 4 / 3 },
    { id: '4:5', label: '4:5', r: 4 / 5 },
    { id: '21:9', label: '21:9', r: 21 / 9 },
  ];

  let collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem('insp-collapsed') || '{}'); } catch { collapsed = {}; }

  // ------------------------------------------------------------------ componentes
  function slider({ label, min, max, step = 1, value, def = 0, fmt = (v) => String(v), onInput, onChange }) {
    const input = h('input', { type: 'range', min, max, step, value });
    const val = h('span', { class: `val${value !== def ? ' changed' : ''}`, title: 'Doble clic para restablecer' }, fmt(value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = fmt(v);
      val.classList.toggle('changed', v !== def);
      onInput(v);
    });
    input.addEventListener('change', () => onChange && onChange(Number(input.value)));
    const reset = () => {
      input.value = def;
      paintRange(input);
      val.textContent = fmt(def);
      val.classList.remove('changed');
      onInput(def);
      onChange && onChange(def);
    };
    val.addEventListener('dblclick', reset);
    input.addEventListener('dblclick', reset);
    paintRange(input);
    return h('div', { class: 'slider' }, h('span', { class: 'lbl' }, label), val, input);
  }

  function section(id, title, ic, body, { modified } = {}) {
    const el = h('div', { class: `section${collapsed[id] ? ' collapsed' : ''}` },
      h('div', {
        class: 'section-head',
        html: icon(ic),
        onclick: () => {
          collapsed[id] = !collapsed[id];
          el.classList.toggle('collapsed', collapsed[id]);
          try { localStorage.setItem('insp-collapsed', JSON.stringify(collapsed)); } catch { /* sin almacenamiento */ }
        },
      }, h('span', null, title), modified ? h('span', { class: 'dot', title: 'Modificado' }) : null, h('span', { class: 'chev', html: icon('chevron') })),
      h('div', { class: 'section-body' }, body));
    return el;
  }

  const live = () => App.renderLive();
  const commit = () => App.commit();
  const signed = (v) => (v > 0 ? `+${v}` : String(v));

  // ------------------------------------------------------------------ secciones
  function trimSection(c, m) {
    const fps = m.info.fps;
    const timeInput = (key) => {
      const inp = h('input', { type: 'text', value: Core.formatTime(c[key], 3) });
      inp.addEventListener('change', () => {
        const t = Core.parseTime(inp.value, fps);
        if (t == null) { inp.value = Core.formatTime(c[key], 3); return toast('Formato de tiempo no válido (usa m:ss.mmm)', 'warn'); }
        if (key === 'in') c.in = clamp(t, 0, c.out - 0.05);
        else c.out = clamp(t, c.in + 0.05, m.info.duration);
        commit();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      return inp;
    };
    return section('trim', 'Recorte', 'trim', [
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Entrada'), timeInput('in')),
        h('label', { class: 'field' }, h('span', null, 'Salida'), timeInput('out'))),
      h('div', { class: 'hint' }, `Duración del clip: ${Core.formatTime(c.out - c.in, 2)} de ${Core.formatTime(m.info.duration, 2)} · en la secuencia: ${Core.formatTime(Core.clipDuration(c), 2)}`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => App.markAtPlayhead('in'), title: 'Tecla I' }, '[ Entrada aquí'),
        h('button', { class: 'btn small', onclick: () => App.markAtPlayhead('out'), title: 'Tecla O' }, 'Salida aquí ]'),
        h('button', { class: 'btn small ghost', html: icon('reset'), title: 'Restablecer recorte', onclick: () => { c.in = 0; c.out = m.info.duration; commit(); } })),
      h('div', { class: 'hint' }, 'También puedes arrastrar los bordes del clip en la línea de tiempo o dividirlo con S.'),
    ], { modified: c.in > 0.001 || c.out < m.info.duration - 0.001 });
  }

  function speedSection(c) {
    const setSpeed = (v, doCommit) => {
      c.speed = clamp(Math.round(v * 100) / 100, 0.1, 16);
      if (doCommit) commit(); else live();
    };
    const numInput = h('input', { type: 'number', min: 0.1, max: 16, step: 0.05, value: c.speed, style: { width: '80px' } });
    numInput.addEventListener('change', () => setSpeed(Number(numInput.value) || 1, true));
    return section('speed', 'Velocidad', 'speed', [
      h('div', { class: 'chips' }, SPEEDS.map((s) => h('button', {
        class: `chip${Math.abs(c.speed - s) < 1e-3 ? ' on' : ''}`, onclick: () => setSpeed(s, true),
      }, `${s}×`))),
      slider({
        label: 'Velocidad personalizada', min: 0.1, max: 4, step: 0.05, value: Math.min(4, c.speed), def: 1,
        fmt: (v) => `${v.toFixed(2)}×`, onInput: (v) => setSpeed(v, false), onChange: () => commit(),
      }),
      h('div', { class: 'row' }, h('label', null, 'Exacta'), numInput, h('span', { class: 'hint' }, 'de 0.1× a 16×')),
      h('div', { class: 'hint' }, c.speed < 1
        ? 'Cámara lenta. Para que se vea fluida, exporta con «Interpolación de movimiento».'
        : 'El tono del audio se conserva al cambiar la velocidad.'),
    ], { modified: Math.abs(c.speed - 1) > 1e-3 });
  }

  function colorSection(c, m) {
    const col = c.color;
    const presetGrid = h('div', { class: 'presets' }, Core.COLOR_PRESETS.map((p) => h('div', {
      class: `preset${col.preset === p.id ? ' on' : ''}`,
      onclick: () => { col.preset = p.id; col.intensity = 100; commit(); },
    },
    h('div', { class: 'pimg', style: { backgroundImage: m.thumbs ? `url("${m.thumbs.poster}")` : 'none', filter: p.id === 'none' ? 'none' : `url(#sw-${p.id})` } }),
    h('div', { class: 'plbl' }, p.label))));

    const adj = (key, label, min = -100, max = 100) => slider({
      label, min, max, value: col[key], def: 0, fmt: signed,
      onInput: (v) => { col[key] = v; live(); }, onChange: commit,
    });

    return section('color', 'Color y filtros', 'palette', [
      presetGrid,
      col.preset !== 'none' ? slider({
        label: 'Intensidad del filtro', min: 0, max: 100, value: col.intensity, def: 100, fmt: (v) => `${v}%`,
        onInput: (v) => { col.intensity = v; live(); }, onChange: commit,
      }) : null,
      h('div', { class: 'subhead' }, 'Luz'),
      adj('exposure', 'Exposición'),
      adj('brightness', 'Brillo'),
      adj('contrast', 'Contraste'),
      h('div', { class: 'subhead' }, 'Color'),
      adj('saturation', 'Saturación'),
      adj('temperature', 'Temperatura'),
      adj('tint', 'Matiz (verde / magenta)'),
      slider({ label: 'Tono', min: -180, max: 180, value: col.hue, def: 0, fmt: (v) => `${signed(v)}°`, onInput: (v) => { col.hue = v; live(); }, onChange: commit }),
      h('div', { class: 'subhead' }, 'Efectos'),
      slider({ label: 'Nitidez', min: 0, max: 100, value: col.sharpen, def: 0, fmt: String, onInput: (v) => { col.sharpen = v; live(); }, onChange: commit }),
      slider({ label: 'Viñeta', min: 0, max: 100, value: col.vignette, def: 0, fmt: String, onInput: (v) => { col.vignette = v; live(); }, onChange: commit }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', html: icon('reset'), onclick: () => { c.color = Core.defaultColor(); commit(); } }, 'Restablecer'),
        h('button', {
          class: 'btn small', html: icon('layers'), title: 'Copia estos ajustes de color a todos los clips',
          onclick: () => {
            state.clips.forEach((o) => { o.color = JSON.parse(JSON.stringify(col)); });
            commit();
            toast('Color aplicado a todos los clips', 'ok', 2000);
          },
        }, 'Aplicar a todos')),
    ], { modified: !Core.isDefaultColor(col) });
  }

  function transformSection(c, m) {
    const rot = (d) => { c.rotate = (((c.rotate + d) % 360) + 360) % 360; c.crop = null; commit(); };
    const cropBtn = h('button', {
      class: `btn small${App.player.cropEdit ? ' active' : ''}`, id: 'btn-crop-edit', html: icon('crop'),
      onclick: () => App.player.setCropEdit(!App.player.cropEdit),
    }, App.player.cropEdit ? 'Terminar encuadre' : 'Editar encuadre');
    const rw = c.rotate % 180 ? m.info.height : m.info.width, rh = c.rotate % 180 ? m.info.width : m.info.height;
    return section('transform', 'Transformar y encuadre', 'transform', [
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', html: icon('rotateCcw'), title: 'Girar 90° a la izquierda', onclick: () => rot(-90) }, '90°'),
        h('button', { class: 'btn small', html: icon('rotateCw'), title: 'Girar 90° a la derecha', onclick: () => rot(90) }, '90°'),
        h('button', { class: `btn small${c.flipH ? ' active' : ''}`, html: icon('flipH'), title: 'Voltear horizontal', onclick: () => { c.flipH = !c.flipH; commit(); } }),
        h('button', { class: `btn small${c.flipV ? ' active' : ''}`, html: icon('flipV'), title: 'Voltear vertical', onclick: () => { c.flipV = !c.flipV; commit(); } })),
      h('div', { class: 'subhead' }, 'Encuadre (recorte de imagen)'),
      h('div', { class: 'chips' }, CROP_ASPECTS.map((a) => h('button', {
        class: `chip${(App.player.cropAspect || null) === a.r ? ' on' : ''}`,
        onclick: () => {
          if (!App.player.cropEdit) App.player.setCropEdit(true);
          App.player.setCropAspect(a.r);
          if (!a.r) I.render();
        },
      }, a.label))),
      h('div', { class: 'btn-row' }, cropBtn,
        h('button', { class: 'btn small ghost', html: icon('reset'), disabled: !c.crop, onclick: () => { c.crop = null; App.player.cropAspect = null; commit(); } }, 'Quitar')),
      h('div', { class: 'hint' }, c.crop
        ? `Encuadre: ${Math.round(c.crop.w * rw)} × ${Math.round(c.crop.h * rh)} px de ${rw} × ${rh}`
        : 'Sin encuadre. Arrastra el recuadro en el visor para recortar la imagen.'),
    ], { modified: !!(c.rotate || c.flipH || c.flipV || c.crop) });
  }

  function audioSection(c, m) {
    const maxFade = Math.max(0.1, Math.min(5, Core.clipDuration(c) / 2));
    const mute = h('input', { type: 'checkbox', class: 'switch', checked: c.muted });
    mute.addEventListener('change', () => { c.muted = mute.checked; commit(); });
    return section('audio', 'Audio y fundidos', 'volume', [
      m.info.hasAudio ? slider({
        label: 'Volumen', min: 0, max: 200, value: Math.round(c.volume * 100), def: 100, fmt: (v) => `${v}%`,
        onInput: (v) => { c.volume = v / 100; live(); }, onChange: commit,
      }) : h('div', { class: 'hint' }, 'Este vídeo no tiene pista de audio.'),
      m.info.hasAudio ? h('label', { class: 'check-row' }, mute, 'Silenciar clip') : null,
      m.info.hasAudio && c.volume > 1 ? h('div', { class: 'hint' }, 'La vista previa llega al 100%; el aumento se aplica al exportar.') : null,
      h('div', { class: 'subhead' }, 'Fundidos (vídeo y audio)'),
      slider({ label: 'Fundido de entrada', min: 0, max: maxFade, step: 0.1, value: Math.min(c.fadeIn, maxFade), def: 0, fmt: (v) => `${v.toFixed(1)} s`, onInput: (v) => { c.fadeIn = v; live(); }, onChange: commit }),
      slider({ label: 'Fundido de salida', min: 0, max: maxFade, step: 0.1, value: Math.min(c.fadeOut, maxFade), def: 0, fmt: (v) => `${v.toFixed(1)} s`, onInput: (v) => { c.fadeOut = v; live(); }, onChange: commit }),
    ], { modified: c.muted || Math.abs(c.volume - 1) > 1e-3 || c.fadeIn > 0 || c.fadeOut > 0 });
  }

  function infoSection(m) {
    const i = m.info;
    const kv = (k, v) => [h('dt', null, k), h('dd', null, v)];
    return section('info', 'Archivo de origen', 'info', [
      h('dl', { class: 'kv' },
        kv('Resolución', `${i.width}×${i.height}`),
        kv('Fotogramas', `${Core.fpsLabel(i.fpsStr)} fps`),
        kv('Duración', Core.formatTime(i.duration, 2)),
        kv('Tamaño', Core.formatBytes(i.size)),
        kv('Bitrate', Core.formatBitrate(i.bitrate / 1000)),
        kv('Vídeo', (i.vcodec || '—').toUpperCase()),
        kv('Audio', i.hasAudio ? (i.acodec || '').toUpperCase() : 'Sin audio')),
      h('div', { class: 'path-box' }, m.path),
    ]);
  }

  // ------------------------------------------------------------------ transición (vídeo)
  function transitionSection(c) {
    const idx = state.clips.indexOf(c);
    if (idx < 0 || idx >= state.clips.length - 1) return null;
    const cur = c.transOut;
    const eff = Core.transitionDur(state.clips, idx);
    return section('transition', 'Transición al siguiente clip', 'transition', [
      h('div', { class: 'trans-grid' },
        h('button', { class: `chip${!cur ? ' on' : ''}`, onclick: () => { c.transOut = null; commit(); } }, 'Corte directo'),
        Core.TRANSITIONS.map((t) => h('button', {
          class: `chip${cur && cur.type === t.id ? ' on' : ''}`,
          onclick: () => { c.transOut = { type: t.id, duration: cur ? cur.duration : 1 }; commit(); },
        }, t.label))),
      cur ? slider({
        label: 'Duración', min: 0.2, max: 3, step: 0.1, value: cur.duration, def: 1, fmt: (v) => `${v.toFixed(1)} s`,
        onInput: (v) => { cur.duration = v; live(); }, onChange: commit,
      }) : null,
      cur && eff < cur.duration - 0.01 ? h('div', { class: 'hint' }, `Limitada a ${eff.toFixed(2)} s por la duración de los clips.`) : null,
    ], { modified: !!cur });
  }

  // ------------------------------------------------------------------ clip de audio
  function audioClipSections(a, body) {
    const m = App.media(a.mediaId);
    const len = a.out - a.in;
    const timeField = (label, get, set) => {
      const inp = h('input', { type: 'text', value: Core.formatTime(get(), 3) });
      inp.addEventListener('change', () => {
        const t = Core.parseTime(inp.value);
        if (t == null) { inp.value = Core.formatTime(get(), 3); return toast('Formato de tiempo no válido (usa m:ss.mmm)', 'warn'); }
        set(t);
        commit();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      return h('label', { class: 'field' }, h('span', null, label), inp);
    };
    const trackSel = h('select', null, state.tracks.map((t) => h('option', { value: t.id }, t.name)));
    trackSel.value = a.trackId;
    trackSel.addEventListener('change', () => { a.trackId = trackSel.value; commit(); });
    body.appendChild(section('aclip', 'Recorte y posición', 'trim', [
      h('div', { class: 'grid2' },
        timeField('Empieza en (línea)', () => a.start, (t) => { a.start = Math.max(0, t); }),
        h('label', { class: 'field' }, h('span', null, 'Pista'), trackSel)),
      h('div', { class: 'grid2' },
        timeField('Entrada (archivo)', () => a.in, (t) => { a.in = clamp(t, 0, a.out - 0.05); }),
        timeField('Salida (archivo)', () => a.out, (t) => { a.out = clamp(t, a.in + 0.05, m.info.duration); })),
      h('div', { class: 'hint' }, `Duración: ${Core.formatTime(len, 2)} de ${Core.formatTime(m.info.duration, 2)}. Arrastra los bordes en la línea de tiempo para recortar.`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', title: 'El clip empieza en el cabezal', onclick: () => { a.start = state.playhead; commit(); } }, 'Mover al cabezal'),
        h('button', { class: 'btn small ghost', html: icon('reset'), onclick: () => { a.in = 0; a.out = m.info.duration; commit(); } }, 'Completo')),
    ], { modified: a.in > 0.001 || a.out < m.info.duration - 0.001 }));

    const mute = h('input', { type: 'checkbox', class: 'switch', checked: a.muted });
    mute.addEventListener('change', () => { a.muted = mute.checked; commit(); });
    const maxFade = Math.max(0.1, Math.min(15, len / 2));
    body.appendChild(section('avol', 'Volumen y fundidos', 'volume', [
      slider({ label: 'Volumen', min: 0, max: 200, value: Math.round(a.volume * 100), def: 100, fmt: (v) => `${v}%`, onInput: (v) => { a.volume = v / 100; live(); }, onChange: commit }),
      h('label', { class: 'check-row' }, mute, 'Silenciar clip'),
      slider({ label: 'Fundido de entrada', min: 0, max: maxFade, step: 0.1, value: Math.min(a.fadeIn, maxFade), def: 0, fmt: (v) => `${v.toFixed(1)} s`, onInput: (v) => { a.fadeIn = v; live(); }, onChange: commit }),
      slider({ label: 'Fundido de salida', min: 0, max: maxFade, step: 0.1, value: Math.min(a.fadeOut, maxFade), def: 0, fmt: (v) => `${v.toFixed(1)} s`, onInput: (v) => { a.fadeOut = v; live(); }, onChange: commit }),
      h('div', { class: 'hint' }, 'El volumen de la pista y los botones M / S de la cabecera también afectan a este clip.'),
    ], { modified: a.muted || Math.abs(a.volume - 1) > 1e-3 || a.fadeIn > 0 || a.fadeOut > 0 }));

    body.appendChild(section('astudio', 'Efectos (Audio Studio)', 'wave', [
      h('div', { class: 'hint' }, 'Crea una versión slowed, reverb, nightcore, lo-fi u 8D de este audio y tráela de vuelta a la línea de tiempo.'),
      h('button', { class: 'btn small accent', html: icon('wave'), onclick: () => { App.showView('studio'); App.studio.load(m.path); } }, 'Abrir en Audio Studio'),
    ]));

    const i = m.info;
    const kv = (k, v) => [h('dt', null, k), h('dd', null, v)];
    body.appendChild(section('ainfo', 'Archivo de origen', 'info', [
      h('dl', { class: 'kv' },
        kv('Duración', Core.formatTime(i.duration, 2)), kv('Formato', (i.acodec || '').toUpperCase()),
        kv('Frecuencia', i.sampleRate ? `${i.sampleRate} Hz` : '—'), kv('Bitrate', Core.formatBitrate(i.bitrate / 1000)),
        kv('Tamaño', Core.formatBytes(i.size))),
      h('div', { class: 'path-box' }, m.path),
    ]));
  }

  // ------------------------------------------------------------------ texto
  function textSections(t, body) {
    const ta = h('textarea', { rows: 3, value: t.text });
    ta.addEventListener('input', () => { t.text = ta.value; live(); });
    ta.addEventListener('change', commit);
    const fontSel = h('select', null, Core.TEXT_FONTS.map((f) => h('option', { value: f, style: { fontFamily: f } }, f)));
    fontSel.value = t.font;
    fontSel.addEventListener('change', () => { t.font = fontSel.value; commit(); });
    const color = h('input', { type: 'color', value: t.color });
    color.addEventListener('input', () => { t.color = color.value; live(); });
    color.addEventListener('change', commit);
    const toggle = (key, ic, title) => h('button', { class: `btn small icon-only${t[key] ? ' active' : ''}`, title, html: icon(ic), onclick: () => { t[key] = !t[key]; commit(); } });
    const align = (v, ic) => h('button', { class: t.align === v ? 'on' : '', html: icon(ic), title: v, onclick: () => { t.align = v; commit(); } });
    body.appendChild(section('ttext', 'Texto', 'type', [
      ta,
      h('div', { class: 'row' }, fontSel, color),
      h('div', { class: 'row' }, toggle('bold', 'bold', 'Negrita'), toggle('italic', 'italic', 'Cursiva'),
        h('div', { class: 'seg' }, align('left', 'alignLeft'), align('center', 'alignCenter'), align('right', 'alignRight'))),
      slider({ label: 'Tamaño', min: 2, max: 30, step: 0.5, value: t.size, def: 8, fmt: (v) => `${v}%`, onInput: (v) => { t.size = v; live(); }, onChange: commit }),
    ]));

    const pos = (x, y) => h('button', { title: 'Colocar', onclick: () => { t.x = x; t.y = y; commit(); } });
    body.appendChild(section('tpos', 'Posición', 'transform', [
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '14px' } },
        h('div', { class: 'pos-grid' }, [0.18, 0.5, 0.82].flatMap((y) => [0.2, 0.5, 0.8].map((x) => pos(x, y)))),
        h('div', { class: 'hint', style: { flex: 1 } }, 'También puedes arrastrar el texto directamente en el visor.')),
      slider({ label: 'Horizontal', min: 0, max: 100, value: Math.round(t.x * 100), def: 50, fmt: (v) => `${v}%`, onInput: (v) => { t.x = v / 100; live(); }, onChange: commit }),
      slider({ label: 'Vertical', min: 0, max: 100, value: Math.round(t.y * 100), def: 82, fmt: (v) => `${v}%`, onInput: (v) => { t.y = v / 100; live(); }, onChange: commit }),
    ]));

    const boxSw = h('input', { type: 'checkbox', class: 'switch', checked: t.box });
    boxSw.addEventListener('change', () => { t.box = boxSw.checked; commit(); });
    const boxColor = h('input', { type: 'color', value: t.boxColor });
    boxColor.addEventListener('input', () => { t.boxColor = boxColor.value; live(); });
    boxColor.addEventListener('change', commit);
    const shSw = h('input', { type: 'checkbox', class: 'switch', checked: t.shadow });
    shSw.addEventListener('change', () => { t.shadow = shSw.checked; commit(); });
    const olColor = h('input', { type: 'color', value: t.outlineColor });
    olColor.addEventListener('input', () => { t.outlineColor = olColor.value; live(); });
    olColor.addEventListener('change', commit);
    body.appendChild(section('tstyle', 'Estilo', 'palette', [
      h('div', { class: 'row' }, h('label', { class: 'check-row', style: { flex: 1 } }, boxSw, 'Fondo'), boxColor),
      t.box ? slider({ label: 'Opacidad del fondo', min: 0, max: 100, value: t.boxOpacity, def: 55, fmt: (v) => `${v}%`, onInput: (v) => { t.boxOpacity = v; live(); }, onChange: commit }) : null,
      h('div', { class: 'row' }, h('span', { class: 'lbl', style: { flex: 1, color: 'var(--text-2)' } }, 'Contorno'), olColor),
      slider({ label: 'Grosor del contorno', min: 0, max: 100, value: t.outline, def: 0, fmt: String, onInput: (v) => { t.outline = v; live(); }, onChange: commit }),
      h('label', { class: 'check-row' }, shSw, 'Sombra'),
    ]));

    const timeField = (label, get, set) => {
      const inp = h('input', { type: 'text', value: Core.formatTime(get(), 2) });
      inp.addEventListener('change', () => {
        const v = Core.parseTime(inp.value);
        if (v == null) { inp.value = Core.formatTime(get(), 2); return; }
        set(v);
        commit();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      return h('label', { class: 'field' }, h('span', null, label), inp);
    };
    const maxFade = Math.max(0.1, Math.min(5, t.duration / 2));
    body.appendChild(section('ttime', 'Tiempo y animación', 'fade', [
      h('div', { class: 'grid2' },
        timeField('Empieza', () => t.start, (v) => { t.start = Math.max(0, v); }),
        timeField('Duración', () => t.duration, (v) => { t.duration = Math.max(0.1, v); })),
      slider({ label: 'Aparición gradual', min: 0, max: maxFade, step: 0.1, value: Math.min(t.fadeIn, maxFade), def: 0.3, fmt: (v) => `${v.toFixed(1)} s`, onInput: (v) => { t.fadeIn = v; live(); }, onChange: commit }),
      slider({ label: 'Desaparición gradual', min: 0, max: maxFade, step: 0.1, value: Math.min(t.fadeOut, maxFade), def: 0.3, fmt: (v) => `${v.toFixed(1)} s`, onInput: (v) => { t.fadeOut = v; live(); }, onChange: commit }),
      h('button', { class: 'btn small', onclick: () => { t.start = state.playhead; commit(); } }, 'Empezar en el cabezal'),
    ]));
  }

  // ------------------------------------------------------------------ render
  function emptyView(body) {
    $('#inspector-sub').textContent = '';
    const kb = (k, d) => [h('kbd', null, k), h('span', null, d)];
    body.appendChild(h('div', { class: 'insp-empty', html: icon('sliders') },
      h('div', null, 'Selecciona un clip de vídeo, audio o texto en la línea de tiempo para editarlo.'),
      h('div', { class: 'kbd-list' },
        kb('Espacio', 'Reproducir / pausa'), kb('← →', 'Fotograma anterior / siguiente'), kb('Mayús + ← →', 'Saltar 1 segundo'),
        kb('S', 'Dividir en el cabezal'), kb('I / O', 'Marcar entrada / salida'), kb('T', 'Añadir texto'), kb('Supr', 'Eliminar'),
        kb('Ctrl + D', 'Duplicar'), kb('Ctrl + Z / Y', 'Deshacer / rehacer'), kb('N', 'Activar / desactivar imán'),
        kb('F', 'Pantalla completa'), kb('Ctrl + rueda', 'Zoom de la línea de tiempo'), kb('Ctrl + E', 'Exportar'))));
  }

  function head(body, thumb, title, sub, kind, label) {
    body.appendChild(h('div', { class: 'clip-head' }, thumb,
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('div', { class: 'title' }, title),
        h('div', { class: 'muted small' }, sub)),
      h('span', { class: `kind-chip ${kind}` }, label)));
  }

  I.render = function () {
    const body = $('#inspector-body');
    const scroll = body.scrollTop;
    const sameItem = body.dataset.item === `${state.selKind}:${state.selectedId}`;
    body.innerHTML = '';
    body.dataset.item = `${state.selKind}:${state.selectedId}`;

    const a = App.selectedAudio();
    const x = App.selectedText();
    const c = App.selectedClip();
    if (a) {
      const m = App.media(a.mediaId);
      $('#inspector-sub').textContent = App.track(a.trackId) ? App.track(a.trackId).name : '';
      head(body, h('div', { class: 'media-thumb audio' }, m.wave ? h('div', { class: 'wv', style: { backgroundImage: `url("${m.wave}")` } }) : null, h('span', { html: icon('music') })),
        m.info.title || m.name, `${Core.formatTime(a.out - a.in, 2)} · empieza en ${Core.formatTime(a.start, 2)}`, 'audio', 'Audio');
      audioClipSections(a, body);
    } else if (x) {
      $('#inspector-sub').textContent = '';
      head(body, h('div', { class: 'media-thumb audio', style: { background: 'linear-gradient(135deg, rgba(251,191,36,.3), rgba(244,114,182,.25))' } }, h('span', { html: icon('type') })),
        x.text.split('\n')[0] || 'Texto', `${Core.formatTime(x.duration, 2)} · empieza en ${Core.formatTime(x.start, 2)}`, 'text', 'Texto');
      textSections(x, body);
    } else if (c) {
      const m = App.clipMedia(c);
      const idx = state.clips.indexOf(c);
      $('#inspector-sub').textContent = `Clip ${idx + 1} de ${state.clips.length}`;
      head(body, h('div', { class: 'media-thumb', id: 'insp-thumb', style: m.thumbs ? { backgroundImage: `url("${m.thumbs.poster}")` } : null }),
        m.name, `${Core.formatTime(Core.clipDuration(c), 2)} en la secuencia`, 'video', 'Vídeo');
      body.appendChild(trimSection(c, m));
      body.appendChild(speedSection(c));
      body.appendChild(colorSection(c, m));
      const tr = transitionSection(c);
      if (tr) body.appendChild(tr);
      body.appendChild(transformSection(c, m));
      body.appendChild(audioSection(c, m));
      body.appendChild(infoSection(m));
    } else emptyView(body);
    if (sameItem) body.scrollTop = scroll;
  };

  I.refreshThumbs = function () {
    const c = App.selectedClip();
    if (!c) return;
    const m = App.clipMedia(c);
    if (m.thumbs && !$('#insp-thumb')?.style.backgroundImage) I.render();
  };

  I.syncCropButton = function () {
    const b = $('#btn-crop-edit');
    if (!b) return;
    b.classList.toggle('active', App.player.cropEdit);
    b.innerHTML = icon('crop') + (App.player.cropEdit ? 'Terminar encuadre' : 'Editar encuadre');
  };

  I.init = function () {
    // Filtros SVG de las miniaturas de cada preset.
    $('#swatch-defs').innerHTML = Core.COLOR_PRESETS.filter((p) => p.id !== 'none')
      .map((p) => Core.svgFilterMarkup(`sw-${p.id}`, { ...Core.defaultColor(), preset: p.id })).join('');
  };
})();
