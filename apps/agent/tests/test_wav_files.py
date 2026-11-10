import wave
from pathlib import Path

import pytest

from classroom_agent.domain.voice_check import PcmAudio
from classroom_agent.infrastructure.wav_files import AudioFileError, read_wav, write_wav


def save(
    path: Path, *, channels: int = 1, width: int = 2, rate: int = 16_000, frames: bytes
) -> Path:
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(width)
        writer.setframerate(rate)
        writer.writeframes(frames)
    return path


def test_round_trip_keeps_mono_pcm(tmp_path: Path) -> None:
    audio = PcmAudio(b"\x01\x00\xff\x7f", 24_000)
    write_wav(tmp_path / "voice.wav", audio)
    assert read_wav(tmp_path / "voice.wav") == audio


def test_stereo_is_mixed_down_to_mono(tmp_path: Path) -> None:
    # Two frames: (100, 300) and (-100, -300).
    frames = (
        (100).to_bytes(2, "little", signed=True)
        + (300).to_bytes(2, "little", signed=True)
        + (-100).to_bytes(2, "little", signed=True)
        + (-300).to_bytes(2, "little", signed=True)
    )
    audio = read_wav(save(tmp_path / "stereo.wav", channels=2, frames=frames))
    assert audio.pcm == (200).to_bytes(2, "little", signed=True) + (-200).to_bytes(
        2, "little", signed=True
    )


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"width": 1, "frames": b"\x01"}, "audio_not_16_bit"),
        ({"rate": 96_000, "frames": b"\x00\x00"}, "audio_sample_rate_unsupported"),
    ],
)
def test_unsupported_formats_are_rejected(
    tmp_path: Path, kwargs: dict[str, object], reason: str
) -> None:
    path = save(tmp_path / "input.wav", **kwargs)  # type: ignore[arg-type]
    with pytest.raises(AudioFileError) as raised:
        read_wav(path)
    assert raised.value.reason == reason


def test_unreadable_files_report_a_fixed_reason(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("not audio")
    cases = {
        tmp_path / "missing.wav": "audio_file_not_found",
        tmp_path / "notes.txt": "audio_not_pcm_wav",
        tmp_path: "audio_file_unreadable",
    }
    for path, reason in cases.items():
        with pytest.raises(AudioFileError) as raised:
            read_wav(path)
        assert raised.value.reason == reason
        assert str(path) not in str(raised.value)
