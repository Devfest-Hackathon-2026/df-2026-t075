// Each browser sends 80 ms of mono, little-endian PCM at 16 kHz per packet.
export const frameBytes = 2560;
export function voiceGate(onTurn) {
  let lead = [],
    frames = [],
    quiet = 0,
    voiced = 0;
  function finish() {
    if (voiced >= 3)
      onTurn(
        Buffer.concat(frames.slice(0, frames.length - Math.max(0, quiet - 2))),
      );
    lead = [];
    frames = [];
    quiet = 0;
    voiced = 0;
  }
  return {
    push(frame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i += 2)
        sum += frame.readInt16LE(i) ** 2;
      const speech = Math.sqrt(sum / (frame.length / 2)) > 320;
      if (!frames.length && !speech) {
        lead.push(frame);
        if (lead.length > 3) lead.shift();
        return;
      }
      if (!frames.length) {
        frames = lead;
        lead = [];
      }
      frames.push(frame);
      if (speech) {
        voiced++;
        quiet = 0;
      } else quiet++;
      if (quiet >= 13 || frames.length >= 300) finish();
    },
    finish,
  };
}
