/* Grabación de voz: copia las muestras del micrófono (en mono) al hilo de la interfaz, en bloques
   de ~85 ms con el número de muestra del primero, para colocarlas luego con precisión. */
class FgRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = true;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.first = 0;
    this.port.onmessage = (e) => { if (e.data === 'stop') { this.flush(); this.on = false; } };
  }

  flush() {
    if (!this.n) return;
    const data = this.buf.slice(0, this.n);
    this.port.postMessage({ frame: this.first, data }, [data.buffer]);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0];
    if (this.on && ch && ch.length) {
      const a = ch[0], b = ch[1];
      if (!this.n) this.first = currentFrame;
      for (let i = 0; i < a.length; i++) {
        this.buf[this.n++] = b ? (a[i] + b[i]) / 2 : a[i];
        if (this.n === this.buf.length) { this.flush(); this.first = currentFrame + i + 1; }
      }
    }
    return this.on;
  }
}
registerProcessor('fg-recorder', FgRecorder);
