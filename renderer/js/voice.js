/*
 * Reconocimiento de voz sin conexión (Vosk) para guardar clips diciendo una frase.
 * Se ejecuta en una ventana oculta; usa una gramática con solo las frases elegidas,
 * lo que lo hace rápido y muy preciso, y reacciona a los resultados parciales.
 */
(function () {
  const api = window.voiceApi;
  let cfg = null;
  let model = null, modelUrl = '';
  let rec = null;
  let ctx = null, stream = null, srcNode = null, proc = null, micLabel = null;
  let lastTrigger = 0, lastLevel = 0, lastText = '';
  let applying = Promise.resolve();

  const send = (d) => api.send(d);
  const status = (state, extra = {}) => send({ type: 'status', state, ...extra });
  // Comparación sin tildes, mayúsculas ni signos.
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  api.onConfig((c) => {
    cfg = c;
    applying = applying.then(apply).catch((e) => status('error', { message: String((e && e.message) || e) }));
  });

  async function apply() {
    if (!model || modelUrl !== cfg.modelUrl) {
      status('loading');
      if (model) { try { model.terminate(); } catch { /* ignorar */ } }
      model = null;
      model = await Vosk.createModel(cfg.modelUrl, -1);
      modelUrl = cfg.modelUrl;
    }
    await openMic();
    makeRecognizer();
    status('listening', { device: micLabel, test: cfg.test });
  }

  async function openMic() {
    // Primero se pide permiso para que enumerateDevices devuelva los nombres.
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    send({ type: 'devices', devices: devs.map((d) => d.label).filter(Boolean) });
    const want = (cfg.device && devs.find((d) => d.label === cfg.device)) || null;
    const label = want ? want.label : (devs.find((d) => d.deviceId === 'default') || devs[0] || {}).label || 'Predeterminado';
    if (micLabel === label && proc) return;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: want ? { exact: want.deviceId } : undefined,
        channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true,
      },
    });
    micLabel = label;
    if (!ctx) ctx = new AudioContext();
    if (srcNode) srcNode.disconnect();
    if (proc) proc.disconnect();
    srcNode = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      const now = performance.now();
      if (now - lastLevel > 100) {
        let peak = 0;
        for (let i = 0; i < d.length; i += 4) peak = Math.max(peak, Math.abs(d[i]));
        lastLevel = now;
        send({ type: 'level', level: peak });
      }
      if (rec) rec.acceptWaveformFloat(new Float32Array(d), ctx.sampleRate);
    };
    srcNode.connect(proc);
    proc.connect(ctx.destination);
    if (ctx.state !== 'running') await ctx.resume();
  }

  function makeRecognizer() {
    if (rec) { try { rec.remove(); } catch { /* ignorar */ } }
    const phrases = cfg.phrases || [];
    // En modo prueba se reconoce todo para mostrar lo que oye; si no, solo las frases.
    rec = cfg.test ? new model.KaldiRecognizer(ctx.sampleRate) : new model.KaldiRecognizer(ctx.sampleRate, JSON.stringify([...phrases, '[unk]']));
    rec.on('partialresult', (m) => check(m.result.partial, false));
    rec.on('result', (m) => check(m.result.text, true));
  }

  function check(text, final) {
    if (!text) return;
    const clean = text.replace(/\[unk\]/g, '').trim();
    if (clean && (clean !== lastText || final)) {
      lastText = clean;
      send({ type: 'heard', text: clean, final });
    }
    const t = ` ${norm(text)} `;
    const hit = (cfg.phrases || []).find((p) => norm(p) && t.includes(` ${norm(p)} `));
    if (!hit) return;
    const now = performance.now();
    if (now - lastTrigger < cfg.cooldown * 1000) return;
    lastTrigger = now;
    send({ type: 'trigger', phrase: hit });
    // Reconocedor nuevo: así la misma frase no vuelve a dispararse en el mismo enunciado.
    makeRecognizer();
  }
})();
