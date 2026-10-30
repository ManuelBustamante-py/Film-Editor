/* Compresor: reduce un vídeo por porcentaje o a un tamaño exacto en MB. */
(function () {
  const App = window.App;
  const C = (App.compressor = {});
  const comp = {
    info: null, thumbs: null, running: false,
    s: { mode: 'percent', percent: 50, targetMB: 10, codec: 'h264', resolution: 'auto', fps: 'keep', audioKbps: 128, preset: 'medium', twoPass: true, hw: 'none', container: 'mp4' },
  };
  const RES = [
    { id: 'keep', label: 'Mantener original' },
    { id: 'auto', label: 'Automática (recomendada)' },
    { id: '1080', label: '1080p' }, { id: '720', label: '720p' }, { id: '540', label: '540p' }, { id: '480', label: '480p' }, { id: '360', label: '360p' },
  ];
  const FPS = [{ id: 'keep', label: 'Mantener' }, { id: '60', label: '60 fps' }, { id: '30', label: '30 fps' }, { id: '25', label: '25 fps' }, { id: '24', label: '24 fps' }, { id: '15', label: '15 fps' }];
  const AUDIO = [{ id: '0', label: 'Sin audio' }, { id: '48', label: '48 kb/s' }, { id: '64', label: '64 kb/s' }, { id: '96', label: '96 kb/s' }, { id: '128', label: '128 kb/s' }, { id: '192', label: '192 kb/s' }];
  const QUICK_MB = [{ v: 8, l: '8 MB' }, { v: 10, l: '10 MB' }, { v: 16, l: '16 MB' }, { v: 25, l: '25 MB' }, { v: 50, l: '50 MB' }, { v: 100, l: '100 MB' }];

  // Formato de salida según el códec y el contenedor elegidos.
  function formatId(s) {
    if (s.codec === 'vp9') return 'webm-vp9';
    if (s.codec === 'av1') return 'mp4-av1';
    if (s.container === 'mkv') return s.codec === 'h265' ? 'mkv-h265' : 'mkv-h264';
    return s.codec === 'h265' ? 'mp4-h265' : 'mp4-h264';
  }

  function job() {
    const i = comp.info, s = comp.s;
    const clip = {
      path: i.path, srcW: i.width, srcH: i.height, srcFps: i.fps, srcFpsStr: i.fpsStr, srcDuration: i.duration,
      srcSize: i.size, sar: i.sar, hasAudio: i.hasAudio, in: 0, out: i.duration, ...Core.defaultClipProps(),
    };
    const settings = Core.normalizeSettings({
      format: formatId(s),
      aspect: 'auto', fit: 'contain',
      resolution: s.resolution === 'keep' || s.resolution === 'auto' ? 'original' : s.resolution,
      autoDownscale: s.resolution === 'auto',
      fps: s.fps === 'keep' ? 'original' : s.fps, fpsMode: 'dup',
      rateMode: s.mode, percent: s.percent, targetMB: s.targetMB,
      preset: s.preset, twoPass: s.twoPass, hw: s.hw,
      audio: s.audioKbps > 0 && i.hasAudio, audioKbps: s.audioKbps || 128,
    });
    return { clips: [clip], settings };
  }

  async function load(path) {
    try {
      const info = await window.api.probe(path);
      comp.info = info;
      comp.thumbs = null;
      comp.s.targetMB = Math.max(1, Math.round((info.size / Core.MB) * 0.5));
      render();
      window.api.thumbnails(path, info).then((t) => { if (comp.info === info) { comp.thumbs = t; render(); } }).catch(() => {});
    } catch (e) {
      toast(`No se pudo leer el vídeo: ${cleanIpcError(e.message).split('\n').pop()}`, 'err', 6000);
    }
  }

  async function pick() {
    const paths = await window.api.openMedia('video');
    if (paths[0]) load(paths[0]);
  }

  function sel(value, opts, onChange) {
    const s = h('select', null, opts.map((o) => h('option', { value: o.id }, o.label)));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function render() {
    const card = $('#comp-card');
    if (comp.running) return;
    card.innerHTML = '';
    if (!comp.info) {
      const dz = h('div', { class: 'dropzone', html: icon('upload'), onclick: pick },
        h('h3', null, 'Arrastra un vídeo aquí'), h('div', null, 'o haz clic para elegir un archivo'));
      wireDrop(dz);
      card.appendChild(dz);
      return;
    }
    const i = comp.info, s = comp.s;
    const thumb = h('div', { class: 'media-thumb', style: comp.thumbs ? { backgroundImage: `url("${comp.thumbs.poster}")` } : null });
    const fileCard = h('div', { class: 'comp-file' }, thumb,
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'name' }, i.name),
        h('div', { class: 'meta' },
          h('span', { class: 'badge' }, Core.formatBytes(i.size)),
          h('span', { class: 'badge' }, Core.formatTime(i.duration, 1)),
          h('span', { class: 'badge' }, `${i.width}×${i.height}`),
          h('span', { class: 'badge' }, `${Core.fpsLabel(i.fpsStr)} fps`),
          h('span', { class: 'badge' }, Core.formatBitrate(i.bitrate / 1000)),
          h('span', { class: 'badge' }, (i.vcodec || '').toUpperCase()))),
      h('button', { class: 'btn small', html: icon('folder'), onclick: pick }, 'Cambiar'));
    wireDrop(fileCard);
    card.appendChild(fileCard);

    const settings = h('div', { class: 'comp-settings' });
    const side = h('div', { class: 'comp-side' });
    card.appendChild(h('div', { class: 'comp-body' }, settings, side));

    const set = (patch) => { Object.assign(s, patch); render(); };

    settings.appendChild(h('div', { class: 'seg block' },
      h('button', { class: s.mode === 'percent' ? 'on' : '', onclick: () => set({ mode: 'percent' }) }, 'Por porcentaje'),
      h('button', { class: s.mode === 'size' ? 'on' : '', onclick: () => set({ mode: 'size' }) }, 'Tamaño exacto (MB)')));

    if (s.mode === 'percent') {
      const v = h('span', { class: 'v' }, `${s.percent}%`);
      const sub = h('span', { class: 's' }, `del original → ${Core.formatBytes((i.size * s.percent) / 100)}`);
      const inp = h('input', { type: 'range', class: 'big', min: 5, max: 95, step: 1, value: s.percent });
      paintRange(inp);
      inp.addEventListener('input', () => {
        s.percent = Number(inp.value);
        v.textContent = `${s.percent}%`;
        sub.textContent = `del original → ${Core.formatBytes((i.size * s.percent) / 100)}`;
        renderSide(side);
      });
      settings.appendChild(h('div', { class: 'field' }, h('div', { class: 'comp-big' }, v, sub), inp,
        h('div', { class: 'chips' }, [10, 25, 40, 50, 60, 75].map((p) =>
          h('button', { class: `chip${s.percent === p ? ' on' : ''}`, onclick: () => set({ percent: p }) }, `${p}%`)))));
    } else {
      const mb = h('input', { type: 'number', min: 0.1, step: 0.5, value: s.targetMB });
      mb.addEventListener('input', () => { s.targetMB = Math.max(0.1, Number(mb.value) || 0.1); renderSide(side); });
      mb.addEventListener('change', () => render());
      settings.appendChild(h('div', { class: 'field' },
        h('span', null, 'Tamaño del archivo final'),
        h('div', { class: 'mb-input' }, mb, h('span', null, 'MB'),
          h('span', { class: 'hint', style: { marginLeft: '8px' } }, `Original: ${Core.formatBytes(i.size)}`)),
        h('div', { class: 'chips' }, QUICK_MB.map((q) =>
          h('button', { class: `chip${s.targetMB === q.v ? ' on' : ''}`, onclick: () => set({ targetMB: q.v }) }, q.l)))));
    }

    const caps = App.state.caps;
    const hwOpts = [{ id: 'none', label: 'CPU' }].concat(caps ? Object.entries(caps.hw).filter(([, v]) => v[s.codec]).map(([id, v]) => ({ id, label: v.label })) : []);
    const resOpts = RES.filter((r) => isNaN(Number(r.id)) || Number(r.id) < Math.min(i.width, i.height));
    const tp = h('input', { type: 'checkbox', class: 'switch', checked: s.twoPass, disabled: s.hw !== 'none' });
    tp.addEventListener('change', () => set({ twoPass: tp.checked }));
    settings.appendChild(h('div', { class: 'adv' },
      h('label', { class: 'field' }, h('span', null, 'Códec'), sel(s.codec, [{ id: 'h264', label: 'H.264 (compatible)' }, { id: 'h265', label: 'H.265 (más compresión)' },
        { id: 'vp9', label: 'VP9 · WebM (web)' }, ...(caps && caps.sw.av1 ? [{ id: 'av1', label: 'AV1 (máxima compresión, lento)' }] : [])], (v) => set({ codec: v, hw: 'none' }))),
      s.codec === 'h264' || s.codec === 'h265' ? h('label', { class: 'field' }, h('span', null, 'Contenedor'), sel(s.container || 'mp4', [{ id: 'mp4', label: 'MP4' }, { id: 'mkv', label: 'MKV' }], (v) => set({ container: v }))) : null,
      h('label', { class: 'field' }, h('span', null, 'Resolución'), sel(s.resolution, resOpts, (v) => set({ resolution: v }))),
      h('label', { class: 'field' }, h('span', null, 'Fotogramas'), sel(s.fps, FPS, (v) => set({ fps: v }))),
      h('label', { class: 'field' }, h('span', null, 'Audio'), sel(String(i.hasAudio ? s.audioKbps : 0), i.hasAudio ? AUDIO : [AUDIO[0]], (v) => set({ audioKbps: Number(v) }))),
      h('label', { class: 'field' }, h('span', null, 'Velocidad'), sel(s.preset, Core.PRESETS, (v) => set({ preset: v }))),
      h('label', { class: 'field' }, h('span', null, 'Codificador'), sel(s.hw, hwOpts, (v) => set({ hw: v })))));
    settings.appendChild(h('label', { class: 'check-row' }, tp, s.hw === 'none' ? 'Dos pasadas (tamaño final muy preciso)' : 'Dos pasadas (solo con CPU)'));

    renderSide(side);
  }

  function renderSide(side) {
    const { clips, settings } = job();
    const plan = Core.planOutput(clips, settings);
    const i = comp.info;
    side.innerHTML = '';
    const kv = (k, v) => [h('dt', null, k), h('dd', null, v)];
    const reduction = 1 - plan.estimatedBytes / i.size;
    side.appendChild(h('div', { class: 'sum-title' }, 'Resultado'));
    side.appendChild(h('div', { class: 'big-size' }, Core.formatBytes(plan.estimatedBytes)));
    side.appendChild(h('div', { class: reduction > 0 ? 'muted' : 'warnbox' },
      reduction > 0 ? `${Math.round(reduction * 100)}% más pequeño que el original` : 'El objetivo no es menor que el original: el archivo no se reducirá.'));
    side.appendChild(h('dl', { class: 'kv' },
      kv('Resolución', `${plan.width}×${plan.height}${plan.scaled ? ' (auto)' : ''}`),
      kv('Fotogramas', `${Core.fpsLabel(plan.fpsStr)} fps`),
      kv('Vídeo', Core.formatBitrate(plan.videoKbps)),
      kv('Audio', settings.audio ? Core.formatBitrate(plan.audioKbps) : 'Sin audio')));
    if (plan.quality) {
      side.appendChild(h('div', { class: 'quality' },
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Calidad estimada'), h('span', { class: 'spacer' }), h('b', null, plan.quality.label)),
        h('div', { class: 'qbar', 'data-l': plan.quality.level }, h('span'), h('span'), h('span'), h('span'), h('span'))));
    }
    if (plan.error) side.appendChild(h('div', { class: 'warnbox err', html: icon('alert') }, h('span', null, plan.error)));
    plan.warnings.forEach((w) => side.appendChild(h('div', { class: 'warnbox', html: icon('alert') }, h('span', null, w))));
    side.appendChild(h('span', { class: 'spacer' }));
    side.appendChild(h('button', { class: 'btn primary big', html: icon('compress'), disabled: !!plan.error, onclick: start }, 'Comprimir'));
  }

  async function start() {
    const i = comp.info;
    const ext = Core.FORMAT_MAP[formatId(comp.s)].container;
    const out = await window.api.saveExportPath({ defaultName: `${dirName(i.path)}\\${stripExt(i.name)}_comprimido.${ext}`, ext });
    if (!out) return;
    const j = job();
    if (!App.checkOutputPath(out, j.clips)) return;
    comp.running = true;
    const card = $('#comp-card');
    const host = h('div', { class: 'comp-progress' });
    card.innerHTML = '';
    card.appendChild(host);
    await App.runJob({
      job: { ...j, outputPath: out },
      host,
      title: `Comprimiendo ${i.name}…`,
      original: i.size,
      onClose: () => { comp.running = false; render(); },
      onBack: () => { comp.running = false; render(); },
    });
  }

  function wireDrop(el) {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('drag-over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) load(window.api.pathForFile(f));
    });
  }

  C.load = load;
  C.init = render;
  C.render = render;
})();
