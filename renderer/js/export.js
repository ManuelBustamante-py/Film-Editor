/* Diálogo de exportación y vistas de progreso / resultado (compartidas con el compresor). */
(function () {
  const App = window.App;
  const { state } = App;
  const E = (App.exporter = {});

  const FPS_MODES = [
    { id: 'dup', label: 'Rápido', hint: 'Duplica o descarta fotogramas. Muy rápido; ideal si el fps no cambia mucho.' },
    { id: 'blend', label: 'Mezcla', hint: 'Fusiona fotogramas vecinos: movimiento más suave que duplicar, coste moderado.' },
    { id: 'mci', label: 'Interpolación', hint: 'Genera fotogramas nuevos estimando el movimiento. El más fluido (cámara lenta, 24→60 fps), pero lento.' },
  ];
  const RATE_MODES = [
    { id: 'crf', label: 'Calidad' },
    { id: 'size', label: 'Tamaño (MB)' },
    { id: 'percent', label: 'Porcentaje' },
    { id: 'bitrate', label: 'Bitrate' },
  ];
  const AUDIO_KBPS = [64, 96, 128, 160, 192, 256, 320];
  // Ajustes rápidos por plataforma.
  const PLATFORMS = [
    { label: 'YouTube 1080p', s: { format: 'mp4-h264', resolution: '1080', aspect: '16:9', fit: 'contain', fps: 'original', rateMode: 'crf', crf: 20, audioKbps: 192 } },
    { label: 'YouTube 4K', s: { format: 'mp4-h264', resolution: '2160', aspect: '16:9', fit: 'contain', fps: 'original', rateMode: 'crf', crf: 18, audioKbps: 256 } },
    { label: 'TikTok / Reels', s: { format: 'mp4-h264', resolution: '1080', aspect: '9:16', fit: 'cover', fps: '30', rateMode: 'crf', crf: 21, audioKbps: 192 } },
    { label: 'Instagram 4:5', s: { format: 'mp4-h264', resolution: '1080', aspect: '4:5', fit: 'cover', fps: '30', rateMode: 'crf', crf: 21, audioKbps: 192 } },
    { label: 'WhatsApp · 16 MB', s: { format: 'mp4-h264', resolution: '720', rateMode: 'size', targetMB: 15.5, autoDownscale: true, twoPass: true, audioKbps: 128 } },
    { label: 'Discord · 10 MB', s: { format: 'mp4-h264', resolution: '720', rateMode: 'size', targetMB: 9.5, autoDownscale: true, twoPass: true, audioKbps: 96 } },
    { label: 'Máxima calidad', s: { format: 'mp4-h264', resolution: 'original', rateMode: 'crf', crf: 16, preset: 'slow', audioKbps: 320 } },
    { label: 'ProRes (edición)', s: { format: 'mov-prores', resolution: 'original' } },
  ];

  // ------------------------------------------------------------------ vistas compartidas
  App.progressView = function ({ title = 'Exportando…', onCancel }) {
    const pct = h('div', { class: 'pct' }, '0%');
    const bar = h('div');
    const pbar = h('div', { class: 'pbar indet' }, bar);
    const stat = (label) => { const b = h('b', null, '—'); return { el: h('div', { class: 'pstat' }, b, h('span', null, label)), b }; };
    const sPass = stat('Pasada'), sSpeed = stat('Velocidad'), sFps = stat('FPS de codificación'), sEta = stat('Tiempo restante');
    const sub = h('div', { class: 'muted' }, 'Preparando…');
    const el = h('div', { class: 'progress-view' },
      h('h3', { style: { margin: 0 } }, title), pct, pbar, sub,
      h('div', { class: 'pstats' }, sPass.el, sSpeed.el, sFps.el, sEta.el),
      onCancel ? h('button', { class: 'btn', onclick: onCancel }, 'Cancelar') : null);
    return {
      el,
      update(d) {
        const o = clamp(d.overall ?? d.pct ?? 0, 0, 1);
        pbar.classList.toggle('indet', o <= 0);
        bar.style.width = `${o * 100}%`;
        pct.textContent = `${(o * 100).toFixed(o < 0.1 ? 1 : 0)}%`;
        sPass.b.textContent = d.passes ? `${d.pass} / ${d.passes}` : '—';
        sSpeed.b.textContent = d.speed ? `${d.speed.toFixed(2)}×` : '—';
        sFps.b.textContent = d.fps ? Math.round(d.fps) : '—';
        if (o > 0.01 && d.elapsed) sEta.b.textContent = Core.formatDuration((d.elapsed * (1 - o)) / o);
        sub.textContent = d.passes > 1
          ? (d.pass === 1 ? 'Pasada 1: analizando el vídeo para ajustar el tamaño…' : 'Pasada 2: codificando el resultado final…')
          : `Procesado ${Core.formatTime(d.time || 0, 1)}`;
      },
    };
  };

  App.resultView = function (res, { onClose, onBack, original } = {}) {
    if (res.ok) {
      const saved = original ? Math.max(0, 1 - res.size / original) : null;
      return h('div', { class: 'progress-view' },
        h('div', { class: 'result-icon', html: icon('check') }),
        h('h3', { style: { margin: 0, fontSize: '18px' } }, '¡Vídeo exportado!'),
        h('div', { class: 'big-size' }, Core.formatBytes(res.size),
          saved != null ? h('small', null, saved > 0 ? `−${Math.round(saved * 100)}% respecto al original` : 'sin reducción') : null),
        h('div', { class: 'muted' }, `Completado en ${Core.formatDuration(res.elapsed)} · ${res.encoder}`),
        h('div', { class: 'path-box' }, res.path),
        h('div', { class: 'btn-row', style: { width: '100%', maxWidth: '520px' } },
          h('button', { class: 'btn', html: icon('folder'), onclick: () => window.api.showItem(res.path) }, 'Mostrar en carpeta'),
          h('button', { class: 'btn', html: icon('play2'), onclick: () => window.api.openPath(res.path) }, 'Reproducir'),
          onClose ? h('button', { class: 'btn primary', onclick: onClose }, 'Listo') : null));
    }
    return h('div', { class: 'progress-view' },
      h('div', { class: 'result-icon err', html: icon(res.cancelled ? 'x' : 'alert') }),
      h('h3', { style: { margin: 0, fontSize: '18px' } }, res.cancelled ? 'Exportación cancelada' : 'No se pudo exportar'),
      res.cancelled ? null : h('div', { class: 'err-pre' }, cleanIpcError(res.error)),
      h('div', { class: 'btn-row', style: { width: '100%', maxWidth: '420px' } },
        onBack ? h('button', { class: 'btn', onclick: onBack }, 'Volver a los ajustes') : null,
        onClose ? h('button', { class: 'btn', onclick: onClose }, 'Cerrar') : null));
  };

  // Ejecuta un trabajo de exportación mostrando el progreso en `host`.
  App.runJob = async function ({ job, host, title, onLock, original, onClose, onBack }) {
    const id = uid('job');
    const pv = App.progressView({ title, onCancel: () => window.api.cancelJob(id) });
    host.innerHTML = '';
    host.appendChild(pv.el);
    onLock && onLock(true);
    const off = window.api.onJobProgress((d) => { if (d.id === id) pv.update(d); });
    let res;
    try {
      res = await window.api.startExport({ id, ...job });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    off();
    onLock && onLock(false);
    host.innerHTML = '';
    host.appendChild(App.resultView(res, { onClose, onBack, original }));
    if (res.ok) toast(`Exportado: ${baseName(res.path)} (${Core.formatBytes(res.size)})`, 'ok', 5000);
    return res;
  };

  // Comprueba que la salida no sobrescriba un archivo de entrada.
  App.checkOutputPath = function (out, clips) {
    const norm = (p) => p.replace(/\//g, '\\').toLowerCase();
    if (clips.some((c) => norm(c.path) === norm(out))) {
      toast('No puedes sobrescribir uno de los vídeos de origen. Elige otro nombre.', 'err', 5000);
      return false;
    }
    return true;
  };

  async function defaultDir() {
    try { const d = localStorage.getItem('last-export-dir'); if (d) return d; } catch { /* ignorar */ }
    return (await window.api.paths()).videos;
  }

  // ------------------------------------------------------------------ formulario
  function select(value, options, onChange) {
    const s = h('select', null, options.map((o) => h('option', { value: o.id, disabled: !!o.disabled }, o.label)));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function seg(value, options, onChange, block = true) {
    return h('div', { class: `seg${block ? ' block' : ''}` }, options.map((o) => h('button', {
      class: value === o.id ? 'on' : '', title: o.hint || '', onclick: () => onChange(o.id),
    }, o.label)));
  }

  function group(label, ...children) {
    return h('div', { class: 'group' }, h('div', { class: 'gl' }, label), ...children);
  }

  E.open = function () {
    if (!state.clips.length) return toast('Añade al menos un clip a la línea de tiempo para exportar', 'warn');
    if (App.player.playing) App.player.pause();
    const s = state.settings;
    const caps = state.caps || { sw: { h264: true, h265: true, vp9: true, av1: null, prores: true, opus: true }, hw: {} };
    const form = h('div', { class: 'export-form' });
    const summary = h('div', { class: 'export-summary' });
    const grid = h('div', { class: 'export-grid' }, form, summary);
    const host = h('div', null, grid);
    const exportBtn = h('button', { class: 'btn primary big', html: icon('export'), onclick: () => start() }, 'Exportar vídeo');
    const foot = [
      h('span', { class: 'hint' }, 'Los ajustes se guardan con el proyecto.'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      exportBtn,
    ];
    const m = modal({ title: 'Exportar vídeo', body: host, foot, wide: true });
    const footEl = m.el.querySelector('.modal-foot');

    const set = (patch) => {
      Object.assign(s, patch);
      App.setDirty(true);
      renderForm();
      renderSummary();
      App.syncCanvasControls();
      App.player.layout();
    };

    function renderForm() {
      const ns = Core.normalizeSettings(s);
      const codec = Core.CODECS[ns.codec];
      const avail = (f) => ({ av1: !!caps.sw.av1, prores: caps.sw.prores, h265: caps.sw.h265, vp9: caps.sw.vp9 }[f.codec] ?? true);
      const formats = Core.FORMATS.map((f) => ({ id: f.id, label: `${f.label} — ${f.hint}`, disabled: !avail(f) }));
      const hwOpts = [{ id: 'auto', label: 'Automático (según tu equipo)' }, { id: 'none', label: 'CPU (software, máxima calidad)' }]
        .concat(Object.entries(caps.hw).filter(([, v]) => v[ns.codec]).map(([id, v]) => ({ id, label: `GPU · ${v.label}` })));
      const hwPossible = (ns.codec === 'h264' || ns.codec === 'h265') && hwOpts.length > 2;
      const twoPassPossible = (ns.rateMode === 'size' || ns.rateMode === 'percent') && codec.twoPass && (!hwPossible || s.hw === 'none' || s.hw === 'auto');
      const audioOnly = ns.audioOnly, gif = ns.codec === 'gif';
      exportBtn.lastChild.textContent = audioOnly ? 'Exportar audio' : gif ? 'Exportar GIF' : 'Exportar vídeo';
      const title = m.el.querySelector('.modal-head h2');
      if (title) title.textContent = audioOnly ? 'Exportar audio' : gif ? 'Exportar GIF' : 'Exportar vídeo';
      form.innerHTML = '';

      form.appendChild(group('Ajustes rápidos', h('div', { class: 'preset-row' }, PLATFORMS.map((p) =>
        h('button', { class: 'chip', onclick: () => { set({ hw: 'auto', ...p.s }); toast(`Ajustes de «${p.label}» aplicados`, 'info', 1600); } }, p.label)))));

      form.appendChild(group('Formato',
        select(s.format, formats, (v) => {
          const nc = Core.FORMAT_MAP[v].codec;
          const patch = { format: v };
          if (nc !== ns.codec && Core.CODECS[nc].crf) patch.crf = Core.CODECS[nc].crf.def;
          if (nc !== 'h264' && nc !== 'h265') patch.hw = 'none';
          else if (s.hw === 'none' && !Core.FORMAT_MAP[s.format].codec.startsWith('h26')) patch.hw = 'auto';
          if (v === 'gif') Object.assign(patch, { fps: '15', resolution: '480' });
          set(patch);
        })));

      if (audioOnly) {
        // Solo audio: no hay imagen, fotogramas ni codificador de vídeo.
        const af = Core.AUDIO_FORMATS.find((x) => x.id === ns.aformat);
        form.appendChild(group('Audio',
          h('div', { class: 'cols' },
            af && af.kbps ? h('label', { class: 'field' }, h('span', null, 'Bitrate'),
              select(String(s.audioKbps), AUDIO_KBPS.map((v) => ({ id: String(v), label: `${v} kb/s` })), (v) => set({ audioKbps: Number(v) }))) : h('div', { class: 'hint' }, 'Formato sin pérdida: guarda el sonido tal cual.'),
            h('label', { class: 'field' }, h('span', null, 'Frecuencia'), select(String(s.sampleRate || 'original'), Core.SAMPLE_RATES, (v) => set({ sampleRate: v }))),
            h('label', { class: 'field' }, h('span', null, 'Canales'), select(String(s.channels || 'original'), Core.CHANNELS, (v) => set({ channels: v })))),
          h('div', { class: 'hint' }, 'Se exporta el sonido de la línea de tiempo (clips, música y fundidos), sin la imagen.')));
        return;
      }

      const resRow = h('div', { class: 'cols' },
        h('label', { class: 'field' }, h('span', null, 'Resolución'),
          select(s.resolution, Core.RESOLUTIONS, (v) => set({ resolution: v }))),
        h('label', { class: 'field' }, h('span', null, 'Lienzo (relación de aspecto)'),
          select(s.aspect, Core.ASPECTS, (v) => set({ aspect: v }))));
      const resGroup = group('Imagen', resRow);
      if (s.resolution === 'custom') {
        const wIn = h('input', { type: 'number', min: 16, max: 8192, step: 2, value: s.customW });
        const hIn = h('input', { type: 'number', min: 16, max: 8192, step: 2, value: s.customH });
        wIn.addEventListener('change', () => set({ customW: clamp(Number(wIn.value) || 1920, 16, 8192) }));
        hIn.addEventListener('change', () => set({ customH: clamp(Number(hIn.value) || 1080, 16, 8192) }));
        resGroup.appendChild(h('div', { class: 'cols' },
          h('label', { class: 'field' }, h('span', null, 'Ancho (px)'), wIn),
          h('label', { class: 'field' }, h('span', null, 'Alto (px)'), hIn)));
      }
      resGroup.appendChild(seg(s.fit, [
        { id: 'contain', label: 'Ajustar (bandas negras)', hint: 'El vídeo completo cabe en el lienzo' },
        { id: 'cover', label: 'Rellenar (recorta bordes)', hint: 'El vídeo cubre todo el lienzo' },
      ], (v) => set({ fit: v })));
      form.appendChild(resGroup);

      const fpsGroup = group('Fotogramas por segundo',
        h('div', { class: 'cols' },
          h('label', { class: 'field' }, h('span', null, 'FPS de salida'),
            select(s.fps, Core.FPS_OPTIONS, (v) => set({ fps: v }))),
          s.fps === 'custom' ? (() => {
            const fIn = h('input', { type: 'number', min: 1, max: 480, step: 0.001, value: s.customFps });
            fIn.addEventListener('change', () => set({ customFps: clamp(Number(fIn.value) || 30, 1, 480) }));
            return h('label', { class: 'field' }, h('span', null, 'FPS personalizado'), fIn);
          })() : h('div')),
        seg(s.fpsMode, FPS_MODES, (v) => set({ fpsMode: v })),
        h('div', { class: 'hint' }, FPS_MODES.find((x) => x.id === s.fpsMode).hint));
      form.appendChild(fpsGroup);

      if (!codec.fixedQuality) {
        const rate = group('Calidad y tamaño', seg(s.rateMode, RATE_MODES, (v) => set({ rateMode: v })));
        if (s.rateMode === 'crf') {
          const lo = codec.crf.min, hi = codec.crf.max;
          const crf = clamp(s.crf, lo, hi);
          const lbl = h('span', { class: 'val changed' }, `CRF ${crf} · ${Core.crfLabel(ns.codec, crf)}`);
          const inp = h('input', { type: 'range', min: lo, max: hi, step: 1, value: crf });
          paintRange(inp);
          inp.addEventListener('input', () => { s.crf = Number(inp.value); lbl.textContent = `CRF ${s.crf} · ${Core.crfLabel(ns.codec, s.crf)}`; renderSummary(); });
          inp.addEventListener('change', () => App.setDirty(true));
          rate.appendChild(h('div', { class: 'slider' }, h('span', { class: 'lbl' }, 'Calidad constante (menos = mejor)'), lbl, inp));
          rate.appendChild(h('div', { class: 'hint' }, 'El tamaño final depende del contenido. Usa «Tamaño» o «Porcentaje» si necesitas un peso concreto.'));
        } else if (s.rateMode === 'size') {
          const mbIn = h('input', { type: 'number', min: 0.1, step: 0.5, value: s.targetMB });
          mbIn.addEventListener('change', () => set({ targetMB: Math.max(0.1, Number(mbIn.value) || 10) }));
          rate.appendChild(h('div', { class: 'cols' }, h('label', { class: 'field' }, h('span', null, 'Tamaño del archivo final (MB)'), mbIn),
            h('div', { class: 'field' }, h('span', null, 'Rápidos'), h('div', { class: 'chips' }, [8, 10, 25, 50, 100, 500].map((v) =>
              h('button', { class: `chip${Number(s.targetMB) === v ? ' on' : ''}`, onclick: () => set({ targetMB: v }) }, `${v}`))))));
        } else if (s.rateMode === 'percent') {
          const plan = App.plan();
          const lbl = h('span', { class: 'val changed' }, `${s.percent}%`);
          const inp = h('input', { type: 'range', min: 5, max: 100, step: 1, value: s.percent });
          paintRange(inp);
          inp.addEventListener('input', () => { s.percent = Number(inp.value); lbl.textContent = `${s.percent}%`; renderSummary(); });
          inp.addEventListener('change', () => { App.setDirty(true); renderForm(); });
          rate.appendChild(h('div', { class: 'slider' }, h('span', { class: 'lbl' }, `Porcentaje del tamaño original (${Core.formatBytes(plan.sourceBytes)})`), lbl, inp));
        } else {
          const bIn = h('input', { type: 'number', min: 100, step: 100, value: s.bitrateKbps });
          bIn.addEventListener('change', () => set({ bitrateKbps: Math.max(100, Number(bIn.value) || 8000) }));
          rate.appendChild(h('div', { class: 'cols' }, h('label', { class: 'field' }, h('span', null, 'Bitrate de vídeo (kb/s)'), bIn),
            h('div', { class: 'field' }, h('span', null, 'Rápidos'), h('div', { class: 'chips' }, [2500, 5000, 8000, 16000, 35000].map((v) =>
              h('button', { class: `chip${Number(s.bitrateKbps) === v ? ' on' : ''}`, onclick: () => set({ bitrateKbps: v }) }, `${v / 1000}M`))))));
        }
        if (s.rateMode === 'size' || s.rateMode === 'percent') {
          if (twoPassPossible) {
            const tp = h('input', { type: 'checkbox', class: 'switch', checked: s.twoPass });
            tp.addEventListener('change', () => set({ twoPass: tp.checked }));
            rate.appendChild(h('label', { class: 'check-row' }, tp, 'Dos pasadas (tamaño mucho más preciso, tarda el doble)'));
          }
          const ad = h('input', { type: 'checkbox', class: 'switch', checked: s.autoDownscale });
          ad.addEventListener('change', () => set({ autoDownscale: ad.checked }));
          rate.appendChild(h('label', { class: 'check-row' }, ad, 'Reducir la resolución automáticamente si el bitrate queda muy bajo'));
        }
        form.appendChild(rate);
      }

      if (gif) {
        form.appendChild(group('GIF', h('div', { class: 'hint' }, 'Paleta optimizada para cada vídeo. Para que pese poco: 480p o menos y 10–20 fps. Los GIF no llevan sonido.')));
        return;
      }
      const enc = group('Codificación', h('div', { class: 'cols' },
        h('label', { class: 'field' }, h('span', null, 'Velocidad / eficiencia'),
          select(s.preset, Core.PRESETS, (v) => set({ preset: v }))),
        hwPossible ? h('label', { class: 'field' }, h('span', null, 'Codificador'),
          select(s.hw === 'auto' || caps.hw[s.hw] ? s.hw : 'none', hwOpts, (v) => set({ hw: v }))) : h('div')));
      if (hwPossible && s.hw === 'auto') enc.appendChild(h('div', { class: 'hint' }, 'Usa la tarjeta gráfica para calidad o bitrate (mucho más rápido) y la CPU cuando hay que clavar un tamaño (dos pasadas, más preciso).'));
      else if (hwPossible && s.hw !== 'none') enc.appendChild(h('div', { class: 'hint' }, 'La GPU codifica mucho más rápido, con algo menos de eficiencia por MB.'));
      form.appendChild(enc);

      const audioSw = h('input', { type: 'checkbox', class: 'switch', checked: s.audio !== false });
      audioSw.addEventListener('change', () => set({ audio: audioSw.checked }));
      const ac = Core.audioCodecFor(ns);
      const acOpts = Object.entries(Core.AUDIO_CODECS).filter(([id, c]) => id === 'auto' || c.containers.includes(ns.container))
        .map(([id, c]) => ({ id, label: id === 'auto' ? `Automático (${Core.AUDIO_CODECS[Core.defaultAudioCodec(ns.container, ns.codec)].label})` : c.label }));
      const audioGroup = group('Audio', h('label', { class: 'check-row' }, audioSw, 'Incluir audio'));
      if (s.audio !== false) {
        audioGroup.appendChild(h('div', { class: 'cols' },
          h('label', { class: 'field' }, h('span', null, 'Códec de audio'), select(acOpts.some((o) => o.id === s.acodec) ? s.acodec : 'auto', acOpts, (v) => set({ acodec: v }))),
          Core.AUDIO_CODECS[ac].kbps ? h('label', { class: 'field' }, h('span', null, 'Bitrate'),
            select(String(s.audioKbps), AUDIO_KBPS.map((v) => ({ id: String(v), label: `${v} kb/s` })), (v) => set({ audioKbps: Number(v) }))) : h('div', { class: 'hint' }, 'Sin pérdida')));
        audioGroup.appendChild(h('div', { class: 'cols' },
          h('label', { class: 'field' }, h('span', null, 'Frecuencia'), select(String(s.sampleRate || 'original'), Core.SAMPLE_RATES, (v) => set({ sampleRate: v }))),
          h('label', { class: 'field' }, h('span', null, 'Canales'), select(String(s.channels || 'original'), Core.CHANNELS, (v) => set({ channels: v })))));
      }
      form.appendChild(audioGroup);
    }

    function renderSummary() {
      const plan = App.plan();
      const ns = Core.normalizeSettings(s);
      summary.innerHTML = '';
      const kv = (k, v) => [h('dt', null, k), h('dd', null, v)];
      const sizeText = plan.estimatedBytes != null ? Core.formatBytes(plan.estimatedBytes) : 'Variable';
      summary.appendChild(h('div', { class: 'sum-title' }, plan.rateMode === 'crf' ? 'Tamaño estimado' : 'Tamaño final'));
      summary.appendChild(h('div', { class: 'big-size' }, plan.estimatedBytes != null && plan.rateMode !== 'size' && plan.rateMode !== 'percent' ? `≈ ${sizeText}` : sizeText,
        plan.sourceBytes && plan.estimatedBytes ? h('small', null, `${Math.round((plan.estimatedBytes / plan.sourceBytes) * 100)}% del original`) : null));
      if (plan.rateMode === 'crf') summary.appendChild(h('div', { class: 'hint' }, 'En modo calidad el peso depende del contenido del vídeo.'));
      const hwAuto = ns.hw === 'auto' && (ns.rateMode === 'crf' || ns.rateMode === 'bitrate') && state.caps
        ? (state.hwOrder || ['nvenc', 'amf', 'qsv']).find((x) => state.caps.hw[x] && state.caps.hw[x][ns.codec]) : null;
      const encId = ns.hw === 'auto' ? hwAuto : ns.hw;
      const enc = ns.audioOnly ? 'Audio' : ns.codec === 'gif' ? 'GIF' : encId && encId !== 'none' && state.caps && state.caps.hw[encId] && state.caps.hw[encId][ns.codec] ? state.caps.hw[encId].label : 'CPU';
      if (ns.audioOnly || ns.codec === 'gif') {
        const af = Core.AUDIO_FORMATS.find((x) => x.id === ns.aformat);
        summary.appendChild(h('dl', { class: 'kv' },
          kv('Duración', Core.formatTime(plan.duration, 2)),
          kv('Formato', Core.FORMAT_MAP[s.format].label),
          ns.audioOnly ? kv('Audio', af && af.kbps ? Core.formatBitrate(plan.audioKbps) : 'Sin pérdida') : kv('Imagen', `${plan.width}×${plan.height} · ${Core.fpsLabel(plan.fpsStr)} fps`)));
        plan.warnings.forEach((w) => summary.appendChild(h('div', { class: 'warnbox', html: icon('alert') }, h('span', null, w))));
        if (plan.error) summary.appendChild(h('div', { class: 'warnbox err', html: icon('alert') }, h('span', null, plan.error)));
        exportBtn.disabled = !!plan.error;
        return;
      }
      summary.appendChild(h('dl', { class: 'kv' },
        kv('Duración', Core.formatTime(plan.duration, 2)),
        kv('Clips', `${state.clips.length} vídeo · ${state.audioClips.length} audio · ${state.textClips.length} texto`),
        kv('Resolución', `${plan.width}×${plan.height}${plan.scaled ? ' (auto)' : ''}`),
        kv('Fotogramas', `${Core.fpsLabel(plan.fpsStr)} fps`),
        kv('Códec', `${Core.CODECS[ns.codec].label} · ${ns.container.toUpperCase()}`),
        kv('Vídeo', plan.videoKbps != null ? Core.formatBitrate(plan.videoKbps) : plan.rateMode === 'fixed' ? 'ProRes 422 HQ' : `CRF ${s.crf}`),
        kv('Audio', s.audio === false ? 'Sin audio' : `${Core.AUDIO_CODECS[Core.audioCodecFor(ns)].label}${Core.AUDIO_CODECS[Core.audioCodecFor(ns)].kbps ? ` · ${Core.formatBitrate(plan.audioKbps)}` : ''}`),
        kv('Codificador', enc),
        kv('Original', Core.formatBytes(plan.sourceBytes))));
      if (plan.quality) {
        summary.appendChild(h('div', { class: 'quality' },
          h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Calidad estimada'), h('span', { class: 'spacer' }), h('b', null, plan.quality.label)),
          h('div', { class: 'qbar', 'data-l': plan.quality.level }, h('span'), h('span'), h('span'), h('span'), h('span'))));
      }
      if (plan.error) summary.appendChild(h('div', { class: 'warnbox err', html: icon('alert') }, h('span', null, plan.error)));
      plan.warnings.forEach((w) => summary.appendChild(h('div', { class: 'warnbox', html: icon('alert') }, h('span', null, w))));
      exportBtn.disabled = !!plan.error;
    }

    async function start() {
      const plan = App.plan();
      if (plan.error) return;
      const ns = Core.normalizeSettings(s);
      const first = App.clipMedia(state.clips[0]);
      const base = state.projectPath ? stripExt(baseName(state.projectPath)) : `${stripExt(first.name)}_editado`;
      const dir = await defaultDir();
      const out = await window.api.saveExportPath({ defaultName: `${dir}\\${base}.${ns.container}`, ext: ns.container });
      if (!out) return;
      const clips = App.jobClips();
      if (!App.checkOutputPath(out, clips)) return;
      try { localStorage.setItem('last-export-dir', dirName(out)); } catch { /* ignorar */ }
      footEl.hidden = true;
      const texts = await App.jobTexts(plan);
      await App.runJob({
        job: { clips, texts, audios: App.jobAudios(), settings: ns, outputPath: out },
        host,
        title: 'Exportando vídeo…',
        onLock: (v) => m.setLocked(v),
        onClose: () => m.close(),
        onBack: () => { host.innerHTML = ''; host.appendChild(grid); footEl.hidden = false; },
      });
    }

    renderForm();
    renderSummary();
  };
})();
