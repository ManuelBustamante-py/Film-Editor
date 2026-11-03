/* Grabar voz sobre el vídeo (voz en off): el proyecto se reproduce desde el cabezal mientras
   hablas y, al parar, la voz queda como un clip de audio en su pista, en su sitio.
   Para colocarla con precisión se graba con un AudioWorklet que numera las muestras: se sabe en
   qué instante real entró cada una (descontando el retraso del micrófono) y el cabezal del visor
   avanza con el reloj de pared, así que cada muestra cae en su punto de la línea de tiempo. */
(function () {
  const App = window.App;
  const { state } = App;
  const V = (App.voiceover = { recording: false });
  let rec = null;            // grabación en curso
  let chip, btn, countEl;

  const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignorar */ } };

  function constraints(deviceId, listen) {
    // Con altavoces, la cancelación de eco evita que la voz grabada lleve el sonido del proyecto.
    return { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: listen && pref('fg.voHeadphones', '1') !== '1', noiseSuppression: true, autoGainControl: false } };
  }

  async function micList() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  }

  // ------------------------------------------------------------------ diálogo
  V.open = async function () {
    if (rec) return V.stop();
    if (!App.player.endTime()) return toast('Añade primero un vídeo o audio a la línea de tiempo', 'warn');
    if (App.player.playing) App.player.pause();
    if (App.player.mode !== 'sequence') App.player.setMode('sequence');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(constraints(pref('fg.voMic', ''), false)); } catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) {
        return toast(`No se pudo usar el micrófono: ${e.message || e.name}`, 'err', 6000);
      }
    }
    const mics = await micList();
    const o = {
      mic: mics.some((d) => d.deviceId === pref('fg.voMic', '')) ? pref('fg.voMic', '') : stream.getAudioTracks()[0].getSettings().deviceId || '',
      listen: pref('fg.voListen', '1') === '1', headphones: pref('fg.voHeadphones', '1') === '1', countdown: pref('fg.voCountdown', '1') === '1',
      track: pref('fg.voTrack', 'voz'),
    };
    // Medidor de nivel en vivo para comprobar el micrófono antes de grabar.
    const actx = new AudioContext();
    actx.resume().catch(() => {});
    let an = null, raf = 0;
    const meter = h('div', { class: 'vo-meter' }, h('span'));
    const listenMeter = (s) => {
      if (an) an.disconnect();
      an = actx.createAnalyser();
      an.fftSize = 1024;
      actx.createMediaStreamSource(s).connect(an);
    };
    listenMeter(stream);
    const buf = new Float32Array(1024);
    const draw = () => {
      an.getFloatTimeDomainData(buf);
      let p = 0;
      for (const x of buf) p = Math.max(p, Math.abs(x));
      const db = 20 * Math.log10(p || 1e-5);
      meter.firstChild.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
      meter.classList.toggle('hot', db > -3);
      raf = requestAnimationFrame(draw);
    };
    draw();

    const micSel = h('select', null, ...mics.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === o.mic }, d.label || `Micrófono ${i + 1}`)));
    micSel.addEventListener('change', async () => {
      o.mic = micSel.value;
      stream.getTracks().forEach((t) => t.stop());
      try { stream = await navigator.mediaDevices.getUserMedia(constraints(o.mic, false)); listenMeter(stream); } catch (e) { toast(`No se pudo abrir ese micrófono: ${e.message || e.name}`, 'err'); }
    });
    const trackSel = h('select', null, h('option', { value: 'voz', selected: o.track === 'voz' }, 'Pista «Voz» (se crea si no existe)'),
      ...state.tracks.map((t) => h('option', { value: t.id, selected: o.track === t.id }, t.name)));
    trackSel.addEventListener('change', () => { o.track = trackSel.value; });
    const sw = (key, label, hint) => {
      const c = h('input', { type: 'checkbox', class: 'switch', checked: o[key] });
      c.addEventListener('change', () => { o[key] = c.checked; });
      return h('label', { class: 'check-row', title: hint || '' }, c, label);
    };
    const body = h('div', { class: 'vo-form' },
      h('p', { class: 'muted' }, 'El proyecto se reproduce desde el cabezal mientras hablas. Al parar (R, Espacio o el botón rojo) tu voz queda como un clip de audio, en su sitio.'),
      h('label', { class: 'field' }, h('span', null, 'Micrófono'), micSel),
      meter,
      h('label', { class: 'field' }, h('span', null, 'Guardar en'), trackSel),
      sw('listen', 'Escuchar el proyecto mientras grabo'),
      sw('headphones', 'Uso auriculares', 'Sin auriculares se activa la cancelación de eco para que el micrófono no recoja el sonido de los altavoces'),
      sw('countdown', 'Cuenta atrás de 3 segundos'));
    const go = h('button', { class: 'btn accent', html: icon('rec') }, 'Empezar a grabar');
    const cleanup = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); actx.close().catch(() => {}); };
    const dlg = modal({ title: 'Grabar voz', body, foot: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancelar'), go], narrow: true, onClose: cleanup });
    go.addEventListener('click', () => {
      setPref('fg.voMic', o.mic); setPref('fg.voListen', o.listen ? '1' : '0'); setPref('fg.voHeadphones', o.headphones ? '1' : '0');
      setPref('fg.voCountdown', o.countdown ? '1' : '0'); setPref('fg.voTrack', o.track);
      dlg.close();
      start(o).catch((e) => { finish(true); toast(`No se pudo grabar: ${e.message || e}`, 'err', 6000); });
    });
    setTimeout(() => go.focus(), 50);
  };

  // ------------------------------------------------------------------ grabación
  async function start(o) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints(o.mic, o.listen));
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('js/rec-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'fg-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
    rec = { o, stream, ctx, node, chunks: [], offsets: [], startHead: 0, playing: false, peak: 0, t0: 0, stopping: false };
    node.port.onmessage = (e) => {
      if (!rec || rec.ctx !== ctx) return;
      rec.chunks.push(e.data);
      let p = 0;
      for (let i = 0; i < e.data.data.length; i += 4) p = Math.max(p, Math.abs(e.data.data[i]));
      rec.peak = Math.max(rec.peak * 0.85, p);
    };
    V.recording = true;
    updateUi();
    if (o.countdown) {
      for (let n = 3; n > 0 && rec; n--) { countEl.textContent = String(n); countEl.hidden = false; await new Promise((r) => setTimeout(r, 1000)); }
      countEl.hidden = true;
      if (!rec) return;
    }
    App.player.setRecordMute(!o.listen);
    if (state.playhead >= App.player.endTime() - 0.05) App.player.seek(0);
    rec.startHead = state.playhead;
    rec.t0 = performance.now();
    rec.playing = true;
    App.player.play();
    loop();
  }

  // En cada fotograma: relación entre el reloj del audio grabado y el de la página (su mediana
  // descarta los saltos de ~10 ms con que avanza currentTime), nivel y tiempo grabado.
  function loop() {
    if (!rec || !rec.playing) return;
    rec.offsets.push(performance.now() / 1000 - rec.ctx.currentTime);
    if (rec.offsets.length > 4000) rec.offsets.splice(0, 2000);
    updateUi();
    requestAnimationFrame(loop);
  }

  V.stop = function () { if (rec && !rec.stopping) finish(false); };

  async function finish(discard) {
    const r = rec;
    if (!r || r.stopping) return;
    r.stopping = true;
    r.playing = false;
    const clock = App.player.clockState();
    if (App.player.playing) App.player.pause();
    App.player.setRecordMute(false);
    countEl.hidden = true;
    const latIn = Number(r.stream.getAudioTracks()[0].getSettings().latency) || 0;
    r.node.port.postMessage('stop');
    await new Promise((res) => setTimeout(res, 150));
    r.stream.getTracks().forEach((t) => t.stop());
    const sr = r.ctx.sampleRate;
    r.ctx.close().catch(() => {});
    rec = null;
    V.recording = false;
    updateUi();
    if (discard || !r.chunks.length || !r.offsets.length) return;

    const offs = [...r.offsets].sort((a, b) => a - b);
    const D = offs[offs.length >> 1];
    // Muestra f → instante real (f/sr + D − retraso del micrófono) → cabezal (reloj del visor).
    const atTimeline = (f) => clock.head + (f / sr + D - latIn - clock.wall);
    const total = r.chunks.reduce((n, c) => n + c.data.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of r.chunks) { pcm.set(c.data, o); o += c.data.length; }
    const tl0 = atTimeline(r.chunks[0].frame);
    const skip = Math.max(0, Math.round((r.startHead - tl0) * sr));
    const keep = pcm.subarray(Math.min(skip, pcm.length));
    if (keep.length < sr * 0.3) return toast('La grabación es demasiado corta', 'warn');
    const start = Math.max(r.startHead, tl0);

    const name = `Voz ${new Date().toLocaleString('sv-SE').replace(/:/g, '-').slice(0, 19)}`;
    const file = await window.api.saveWav(wav(keep, sr), name);
    const [id] = await App.library.importPaths([file], { quiet: true });
    const m = App.media(id);
    if (!m || !m.info) return toast('No se pudo añadir la grabación', 'err');
    const len = keep.length / sr;
    const track = pickTrack(r.o.track, start, start + len);
    const a = App.createAudioClip(m, { trackId: track.id });
    a.start = start;
    a.out = Math.min(a.out, len);
    state.audioClips.push(a);
    state.selectedId = a.id;
    state.selKind = 'audio';
    App.commit();
    toast(`Voz grabada (${Core.formatTime(len, 1)}) en «${track.name}»`, 'ok', 3500);
    V.last = { start, len, file, skip, latIn, D, tl0, startHead: r.startHead, sr };
  }

  // La pista elegida, o una nueva si ya tiene audio en ese tramo (las tomas no se pisan).
  function pickTrack(choice, s, e) {
    const free = (t) => !state.audioClips.some((a) => a.trackId === t.id && a.start < e && a.start + (a.out - a.in) > s);
    let t = choice !== 'voz' && App.track(choice);
    if (!t) t = state.tracks.find((x) => /^Voz( \d+)?$/.test(x.name) && free(x));
    if (t && free(t)) return t;
    const base = choice === 'voz' || !t ? 'Voz' : t.name;
    let n = 1, nm = base;
    while (state.tracks.some((x) => x.name === nm)) nm = `${base} ${++n}`;
    const nt = App.newTrack(nm);
    state.tracks.push(nt);
    return nt;
  }

  function wav(pcm, sr) {
    const data = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(data);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0, o = 44; i < pcm.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(data);
  }

  // ------------------------------------------------------------------ interfaz
  let shownSec = -1;
  function updateUi() {
    btn.classList.toggle('recording', !!rec);
    btn.title = rec ? 'Detener la grabación (R)' : 'Grabar tu voz sobre el vídeo (R)';
    chip.hidden = !rec;
    if (!rec) { shownSec = -1; return; }
    const sec = rec.playing ? Math.floor((performance.now() - rec.t0) / 1000) : 0;
    if (sec !== shownSec) { shownSec = sec; chip.querySelector('.t').textContent = rec.playing ? Core.formatTime(sec, 0) : 'preparado'; }
    chip.querySelector('.lvl > span').style.width = `${Math.min(100, Math.max(0, ((20 * Math.log10(rec.peak || 1e-5) + 60) / 60) * 100))}%`;
  }

  // Parar el visor o saltar a otro punto termina la toma (antes de que cambie el reloj).
  V.onTransport = function () { if (rec && rec.playing) finish(false); };

  V.init = function () {
    btn = $('#tl-voice');
    chip = $('#rec-status');
    countEl = $('#rec-count');
    btn.addEventListener('click', () => (rec ? V.stop() : V.open()));
    chip.querySelector('button').addEventListener('click', V.stop);
  };
})();
