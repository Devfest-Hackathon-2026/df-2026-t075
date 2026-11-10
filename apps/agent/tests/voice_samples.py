"""Synthetic audio for tests: a tone stands in for speech."""

import math
import sys
from array import array

from classroom_agent.domain.voice_check import PcmAudio


def tone(seconds: float, rate: int = 16_000, amplitude: int = 8_000) -> bytes:
    samples = array(
        "h",
        (
            round(amplitude * math.sin(2 * math.pi * 440 * index / rate))
            for index in range(round(seconds * rate))
        ),
    )
    if sys.byteorder == "big":
        samples.byteswap()
    return samples.tobytes()


def silence(seconds: float, rate: int = 16_000) -> bytes:
    return bytes(round(seconds * rate) * 2)


def speech(spoken: float = 1.0, after: float = 0.5, rate: int = 16_000) -> PcmAudio:
    return PcmAudio(tone(spoken, rate) + silence(after, rate), rate)
