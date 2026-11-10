"""Pure calculations for one voice turn: speech end, accuracy, timing and cost."""

import math
import re
import sys
import unicodedata
from array import array
from dataclasses import dataclass

SAMPLE_WIDTH_BYTES = 2


@dataclass(frozen=True, slots=True)
class PcmAudio:
    """Mono, 16-bit, little-endian PCM."""

    pcm: bytes
    sample_rate: int

    def __post_init__(self) -> None:
        if self.sample_rate <= 0:
            raise ValueError("sample_rate must be positive")
        if len(self.pcm) % SAMPLE_WIDTH_BYTES:
            raise ValueError("pcm must hold whole 16-bit samples")

    @property
    def seconds(self) -> float:
        return len(self.pcm) / SAMPLE_WIDTH_BYTES / self.sample_rate


def _samples_of(pcm: bytes) -> "array[int]":
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % SAMPLE_WIDTH_BYTES])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def _samples(audio: PcmAudio) -> "array[int]":
    return _samples_of(audio.pcm)


def speech_end_seconds(audio: PcmAudio, *, frame_seconds: float = 0.02) -> float | None:
    """Return where the last voiced frame ends, or None when the audio is silent.

    A frame counts as voiced when its loudness reaches 15% of the loudest frame,
    with a floor so that recording noise alone is not treated as speech.
    """
    samples = _samples(audio)
    frame = max(1, round(audio.sample_rate * frame_seconds))
    loudness: list[float] = []
    for start in range(0, len(samples), frame):
        part = samples[start : start + frame]
        loudness.append(math.sqrt(sum(value * value for value in part) / len(part)))
    if not loudness:
        return None
    threshold = max(300.0, max(loudness) * 0.15)
    for index in range(len(loudness) - 1, -1, -1):
        if loudness[index] >= threshold:
            return min(len(samples), (index + 1) * frame) / audio.sample_rate
    return None


# Loudness of a 16-bit chunk treated as someone speaking, about -36 dBFS. The browser's
# noise suppression keeps a quiet room well below this.
VOICED_RMS = 500.0


def chunk_rms(pcm: bytes) -> float:
    """RMS loudness of a mono PCM16 frame."""
    samples = _samples_of(pcm)
    if not samples:
        return 0.0
    return math.sqrt(sum(value * value for value in samples) / len(samples))


def chunk_is_voiced(pcm: bytes) -> bool:
    return chunk_rms(pcm) >= VOICED_RMS


# Seconds of silence after the last voiced audio before the turn is treated as over.
# A finished question can be answered quickly; a sentence that stops on a comma, a
# particle, a conjunction or a filler is probably a pause to think, so wait longer.
HOLD_FINISHED = 0.8
HOLD_UNSURE = 1.5
HOLD_CONTINUING = 2.5
_FINISHED_MARKS = ("。", "？", "?", "！", "!")
_CONTINUING_MARKS = ("、", ",")
_CONTINUING_WORDS = (
    "けど",
    "けれど",
    "けども",
    "から",
    "ので",
    "のに",
    "して",
    "って",
    "とか",
    "たり",
    "えーと",
    "えっと",
    "あの",
    "あのー",
    "その",
    "まあ",
    "なんか",
    "は",
    "が",
    "を",
    "に",
    "で",
    "へ",
    "と",
    "も",
)


def turn_hold_seconds(transcript: str) -> float:
    """How long to wait in silence before replying, from how the words so far end.

    Speech-to-Text may put "。" after a fragment that is not a full sentence, so a
    conjunction or particle before the final mark still counts as continuing.
    """
    text = transcript.strip()
    core = text.rstrip("".join(_FINISHED_MARKS) + "".join(_CONTINUING_MARKS) + "ー…")
    if text.endswith(_CONTINUING_MARKS) or core.endswith(_CONTINUING_WORDS):
        return HOLD_CONTINUING
    if text.endswith(_FINISHED_MARKS):
        return HOLD_FINISHED
    return HOLD_UNSURE


_MARKUP = re.compile(r"<[^<>]*>|[*#`_|\[\]]")


def spoken_text(text: str) -> str:
    """Drop markup a text model may still emit, because the reply is read aloud."""
    return " ".join(_MARKUP.sub("", text).split())


def _normalize(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text).lower()
    return "".join(char for char in folded if unicodedata.category(char)[0] not in ("P", "Z", "C"))


def character_error_rate(reference: str, hypothesis: str) -> float | None:
    """Edit distance per reference character, ignoring spaces, punctuation and width."""
    expected = _normalize(reference)
    actual = _normalize(hypothesis)
    if not expected:
        return None
    previous = list(range(len(actual) + 1))
    for row, expected_char in enumerate(expected, start=1):
        current = [row]
        for column, actual_char in enumerate(actual, start=1):
            current.append(
                min(
                    previous[column] + 1,
                    current[column - 1] + 1,
                    previous[column - 1] + (expected_char != actual_char),
                )
            )
        previous = current
    return previous[-1] / len(expected)


@dataclass(frozen=True, slots=True)
class TurnTimeline:
    """Monotonic clock readings, in seconds, taken while one turn ran."""

    speech_ended: float
    audio_sent: float
    transcript_final: float
    reply_first_text: float
    reply_done: float
    first_audio: float
    audio_done: float

    @property
    def transcript_wait(self) -> float:
        return self.transcript_final - self.speech_ended

    @property
    def reply_first_wait(self) -> float:
        return self.reply_first_text - self.transcript_final

    @property
    def reply_wait(self) -> float:
        return self.reply_done - self.transcript_final

    @property
    def first_audio_wait(self) -> float:
        return self.first_audio - self.reply_done

    @property
    def until_caption(self) -> float:
        return self.reply_done - self.speech_ended

    @property
    def until_ai_speaks(self) -> float:
        return self.first_audio - self.speech_ended

    @property
    def transcript_needed_stream_close(self) -> bool:
        """True when the final transcript arrived only after all audio had been sent.

        Then the wait includes the trailing silence and overstates the delay.
        """
        return self.transcript_final >= self.audio_sent
