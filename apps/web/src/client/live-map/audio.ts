/** Per browser: only its own mic is sent; remote speakers have separate playout queues. */
export class MeetingAudio {
  private ctx = new AudioContext({ sampleRate: 16000 });
  private positions = new Map<number, number>();
  private stream: MediaStream | undefined;
  private capture: AudioWorkletNode | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private module: Promise<void> | undefined;
  private generation = 0;

  constructor(onPlaybackChange?: () => void) {
    this.ctx.onstatechange = onPlaybackChange ?? null;
  }
  get playbackBlocked() {
    return this.ctx.state !== "running";
  }
  resume() {
    return this.ctx.resume();
  }
  async mic(
    send: (frame: ArrayBuffer) => void,
    ended: () => void,
    track?: MediaStreamTrack,
  ) {
    const generation = ++this.generation;
    await this.ctx.resume();
    this.module ??= this.ctx.audioWorklet.addModule("/live-map-capture.js");
    await this.module;
    if (this.generation !== generation) throw new Error("cancelled");
    const stream = track
      ? new MediaStream([track.clone()])
      : await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
    if (this.generation !== generation) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("cancelled");
    }
    this.stream = stream;
    try {
      const source = this.ctx.createMediaStreamSource(stream);
      this.source = source;
      const capture = new AudioWorkletNode(this.ctx, "live-map-capture");
      capture.port.onmessage = (e) => send(e.data);
      this.capture = capture;
      stream.getAudioTracks()[0]!.onended = ended;
      // The processor outputs silence; the local microphone is never played back.
      source.connect(capture).connect(this.ctx.destination);
    } catch {
      this.stopMic();
      throw new Error("microphone");
    }
  }
  stopMic() {
    this.generation++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    if (this.capture) {
      this.capture.port.onmessage = null;
      this.capture.disconnect();
    }
    this.capture = undefined;
    this.source?.disconnect();
    this.source = undefined;
  }
  play(packet: ArrayBuffer) {
    if (packet.byteLength !== 2561 || this.ctx.state !== "running") return;
    const view = new DataView(packet),
      slot = view.getUint8(0);
    const audio = this.ctx.createBuffer(1, 1280, 16000);
    const samples = audio.getChannelData(0);
    for (let i = 0; i < samples.length; i++)
      samples[i] = view.getInt16(1 + i * 2, true) / 32768;
    const at = Math.max(
      this.ctx.currentTime + 0.025,
      this.positions.get(slot) ?? 0,
    );
    if (at - this.ctx.currentTime > 0.45) return;
    this.positions.set(slot, at + audio.duration);
    const source = this.ctx.createBufferSource();
    source.buffer = audio;
    source.connect(this.ctx.destination);
    source.onended = () => source.disconnect();
    source.start(at);
  }
  close() {
    this.ctx.onstatechange = null;
    this.stopMic();
    if (this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
  }
}
