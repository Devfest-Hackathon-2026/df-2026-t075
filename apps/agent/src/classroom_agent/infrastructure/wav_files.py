"""Read a recorded WAV for the voice check and save the AI member's voice."""

import sys
import wave
from array import array
from pathlib import Path

from classroom_agent.domain.voice_check import PcmAudio


class AudioFileError(ValueError):
    """Report a fixed reason; the file path and contents are not included."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def _to_mono(frames: bytes, channels: int) -> bytes:
    samples = array("h")
    samples.frombytes(frames)
    if sys.byteorder == "big":
        samples.byteswap()
    mono = array(
        "h",
        (
            round(sum(samples[index : index + channels]) / channels)
            for index in range(0, len(samples), channels)
        ),
    )
    if sys.byteorder == "big":
        mono.byteswap()
    return mono.tobytes()


def read_wav(path: Path) -> PcmAudio:
    """Accept 16-bit PCM WAV; stereo is mixed down to mono."""
    try:
        with wave.open(str(path), "rb") as reader:
            channels = reader.getnchannels()
            width = reader.getsampwidth()
            rate = reader.getframerate()
            frames = reader.readframes(reader.getnframes())
    except FileNotFoundError as error:
        raise AudioFileError("audio_file_not_found") from error
    except (wave.Error, EOFError) as error:
        raise AudioFileError("audio_not_pcm_wav") from error
    except OSError as error:
        raise AudioFileError("audio_file_unreadable") from error
    if width != 2:
        raise AudioFileError("audio_not_16_bit")
    if not 8_000 <= rate <= 48_000:
        raise AudioFileError("audio_sample_rate_unsupported")
    pcm = frames if channels == 1 else _to_mono(frames, channels)
    return PcmAudio(pcm, rate)


def write_wav(path: Path, audio: PcmAudio) -> None:
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(audio.sample_rate)
        writer.writeframes(audio.pcm)
