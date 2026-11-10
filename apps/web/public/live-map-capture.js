// AudioWorklet global scope. The enclosing AudioContext resamples to 16 kHz.
class LiveMapCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(1280);
    this.used = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      this.frame[this.used++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
      if (this.used === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(1280);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor("live-map-capture", LiveMapCapture);
