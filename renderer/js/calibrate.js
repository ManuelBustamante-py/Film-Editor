/*
 * Calibración de sincronía: 8 destellos blancos, cada uno a la vez que un pitido.
 * El destello se muestra cuando el pitido sale realmente por el dispositivo
 * (según getOutputTimestamp), así la grabación revela el retraso de cada fuente.
 */
(async function () {
  const N = 8, BEEP = 0.06, FRAME = 1000 / 60;
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  const t0 = ctx.currentTime + 1;
  const times = [];
  for (let k = 0; k < N; k++) {
    const t = t0 + k;
    times.push(t);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 2000;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2, t + 0.002);
    g.gain.setValueAtTime(0.2, t + BEEP);
    g.gain.linearRampToValueAtTime(0, t + BEEP + 0.004);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + BEEP + 0.02);
  }
  // Momento (reloj de la página) en que el audio programado para "t" sale por el altavoz.
  const at = (t) => {
    const ts = ctx.getOutputTimestamp();
    return ts.performanceTime + (t - ts.contextTime) * 1000;
  };
  const frame = (now) => {
    // Se adelanta un fotograma para compensar lo que tarda el compositor en mostrarlo.
    const white = times.some((t) => { const a = at(t) - FRAME; return now >= a && now < a + BEEP * 1000; });
    document.body.style.background = white ? '#fff' : '#000';
    if (now > at(times[N - 1]) + 600) { window.close(); return; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
