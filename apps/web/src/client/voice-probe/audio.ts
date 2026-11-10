/** Observe mic and decoded remote audio on the same browser clock. Samples never leave this graph. */
export class ProbeAudio {
  readonly context = new AudioContext();
  private readonly nodes: AudioNode[] = [];
  private readonly timers: number[] = [];
  private lastMic = 0;
  private firstReply = 0;
  private micFinished = false;
  private uninterrupted = !document.hidden;
  private closing?: Promise<void>;

  private readonly onVisibilityChange = () => {
    if (document.hidden && !this.firstReply) this.uninterrupted = false;
  };

  resume() {
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    return this.context.resume();
  }

  async recording(file: File) {
    if (file.size > 8 * 1024 * 1024) throw new Error();
    const buffer = await this.context.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration <= 0 || buffer.duration > 20) throw new Error();
    const source = this.context.createBufferSource();
    const output = this.context.createMediaStreamDestination();
    source.buffer = buffer;
    source.connect(output);
    this.nodes.push(source, output);
    return {
      track: output.stream.getAudioTracks()[0]!,
      start: () => source.start(),
    };
  }

  watch(track: MediaStreamTrack, remote: boolean) {
    if (this.closing) return;
    const source = this.context.createMediaStreamSource(
      new MediaStream([track]),
    );
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    this.nodes.push(source, analyser);
    const samples = new Float32Array(analyser.fftSize);
    this.timers.push(
      window.setInterval(() => {
        if (document.hidden || this.context.state !== "running") {
          if (!this.firstReply) this.uninterrupted = false;
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        if (Math.sqrt(energy / samples.length) < 0.012) return;
        const now = performance.now();
        if (remote) this.firstReply ||= now;
        else if (!this.micFinished && !this.firstReply) this.lastMic = now;
      }, 20),
    );
  }

  finishMic() {
    this.micFinished = true;
  }
  latencyMs() {
    return this.uninterrupted &&
      this.firstReply > this.lastMic &&
      this.lastMic > 0
      ? Math.round(this.firstReply - this.lastMic)
      : null;
  }
  close() {
    if (this.closing) return this.closing;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.timers.forEach((timer) => window.clearInterval(timer));
    this.nodes.forEach((node) => node.disconnect());
    this.closing =
      this.context.state === "closed"
        ? Promise.resolve()
        : this.context.close();
    return this.closing;
  }
}
