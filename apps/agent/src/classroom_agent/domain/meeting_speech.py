"""Segment a single 16 kHz mono microphone. LiveKit delivers 20 ms frames."""

from collections import deque
from dataclasses import dataclass

from classroom_agent.domain.voice_check import VOICED_RMS, chunk_rms

FRAME_MS = 20
PAD = 10  # 200 ms on either side of speech
END_GAP = 16  # 320 ms, before the shortest conversational hold of 800 ms
# At 16 kHz PCM16, 59 seconds is < 2 MB, including padding.
LIMIT = 59_000 // FRAME_MS
SEARCH = 10_000 // FRAME_MS


@dataclass(frozen=True, slots=True)
class Frame:
    pcm: bytes
    at: float
    level: float


@dataclass(frozen=True, slots=True)
class Clip:
    pcm: bytes
    start: float
    end: float


class Microphone:
    def __init__(self) -> None:
        self.lead: deque[Frame] = deque(maxlen=PAD)
        self.frames: list[Frame] = []
        self.quiet = 0
        self.last_voice = float("-inf")

    def feed(self, pcm: bytes, now: float) -> Clip | None:
        frame = Frame(pcm, now, chunk_rms(pcm))
        if frame.level >= VOICED_RMS:
            self.last_voice = now
            self.quiet = 0
            if not self.frames:
                self.frames.extend(self.lead)
                self.lead.clear()
        elif not self.frames:
            self.lead.append(frame)
            return None
        else:
            self.quiet += 1
        self.frames.append(frame)
        if self.quiet >= END_GAP:
            return self.flush()
        if len(self.frames) >= LIMIT:
            # Prefer the most recent brief pause. Otherwise compare 100 ms windows.
            lo = len(self.frames) - SEARCH
            cut = next(
                (
                    i + 1
                    for i in range(len(self.frames) - 1, lo - 1, -1)
                    if self.frames[i].level < VOICED_RMS
                ),
                None,
            )
            if cut is None:
                cut = (
                    min(
                        range(lo, len(self.frames) - 4),
                        key=lambda i: sum(f.level for f in self.frames[i : i + 5]),
                    )
                    + 3
                )
            return self._take(cut)
        return None

    def _take(self, end: int) -> Clip:
        frames, self.frames = self.frames[:end], self.frames[end:]
        voiced = [f for f in frames if f.level >= VOICED_RMS]
        return Clip(b"".join(f.pcm for f in frames), voiced[0].at, voiced[-1].at)

    def flush(self) -> Clip | None:
        if not self.frames:
            return None
        # Keep the unused silence only as the beginning of a future segment.
        cut = len(self.frames) - max(0, self.quiet - PAD)
        clip = self._take(cut)
        self.lead.extend(self.frames)
        self.frames.clear()
        self.quiet = 0
        return clip
