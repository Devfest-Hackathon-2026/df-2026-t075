import pytest
from voice_samples import silence, speech, tone

from classroom_agent.domain.voice_check import (
    HOLD_CONTINUING,
    HOLD_FINISHED,
    HOLD_UNSURE,
    PcmAudio,
    TurnTimeline,
    character_error_rate,
    chunk_is_voiced,
    speech_end_seconds,
    turn_hold_seconds,
)
from classroom_agent.domain.voice_cost import (
    Prices,
    Tokens,
    TurnCost,
    TurnUsage,
    meeting_minute_cost,
    turn_cost,
)


@pytest.mark.parametrize(
    ("transcript", "hold"),
    [
        ("ノト、どう思う？", HOLD_FINISHED),
        ("それでいいと思います。", HOLD_FINISHED),
        ("いいですね!", HOLD_FINISHED),
        ("えーと、次に読む本は", HOLD_CONTINUING),
        ("小説がいいと思うんですけど", HOLD_CONTINUING),
        ("時間がないので。", HOLD_CONTINUING),
        ("まず、", HOLD_CONTINUING),
        ("あのー", HOLD_CONTINUING),
        ("どう思う", HOLD_UNSURE),
        ("", HOLD_UNSURE),
    ],
)
def test_the_silence_to_wait_follows_how_the_words_end(transcript: str, hold: float) -> None:
    assert turn_hold_seconds(transcript) == hold


def test_voiced_chunks_are_told_apart_from_quiet_ones() -> None:
    assert chunk_is_voiced(tone(0.1))
    assert not chunk_is_voiced(tone(0.1, amplitude=200))
    assert not chunk_is_voiced(silence(0.1))
    assert not chunk_is_voiced(b"\x01")


def test_pcm_audio_reports_its_length() -> None:
    assert PcmAudio(bytes(32_000), 16_000).seconds == 1.0


@pytest.mark.parametrize(("pcm", "rate"), [(b"\x00", 16_000), (b"", 0)])
def test_pcm_audio_rejects_broken_input(pcm: bytes, rate: int) -> None:
    with pytest.raises(ValueError):
        PcmAudio(pcm, rate)


def test_speech_end_is_where_the_voice_stops() -> None:
    end = speech_end_seconds(speech(spoken=1.2, after=0.8))
    assert end == pytest.approx(1.2, abs=0.02)


def test_quiet_noise_and_empty_audio_have_no_speech() -> None:
    assert speech_end_seconds(PcmAudio(silence(1.0), 16_000)) is None
    assert speech_end_seconds(PcmAudio(tone(1.0, amplitude=100), 16_000)) is None
    assert speech_end_seconds(PcmAudio(b"", 16_000)) is None


def test_error_rate_ignores_spaces_punctuation_and_width() -> None:
    assert character_error_rate("今日は、晴れ。", "今日は 晴れ") == 0.0
    assert character_error_rate("ＡＩの会議", "AIの会議!") == 0.0
    assert character_error_rate("Ａ＋Ｂ～。\u200b", "a+b") == 0.25


def test_error_rate_counts_substitutions_insertions_and_deletions() -> None:
    assert character_error_rate("あいうえ", "あいおえ") == 0.25
    assert character_error_rate("あいう", "あいうえ") == pytest.approx(1 / 3)
    assert character_error_rate("あいう", "") == 1.0


def test_error_rate_needs_reference_characters() -> None:
    assert character_error_rate("。 、", "何か") is None


def test_timeline_splits_the_wait_before_the_ai_speaks() -> None:
    timeline = TurnTimeline(
        speech_ended=10.0,
        audio_sent=11.5,
        transcript_final=10.8,
        reply_first_text=11.3,
        reply_done=11.6,
        first_audio=12.1,
        audio_done=13.0,
    )
    assert timeline.transcript_wait == pytest.approx(0.8)
    assert timeline.reply_first_wait == pytest.approx(0.5)
    assert timeline.reply_wait == pytest.approx(0.8)
    assert timeline.first_audio_wait == pytest.approx(0.5)
    assert timeline.until_caption == pytest.approx(1.6)
    assert timeline.until_ai_speaks == pytest.approx(2.1)
    assert not timeline.transcript_needed_stream_close


def test_timeline_flags_a_transcript_that_waited_for_the_stream_to_close() -> None:
    timeline = TurnTimeline(10.0, 11.0, 11.0, 11.2, 11.3, 11.5, 12.0)
    assert timeline.transcript_needed_stream_close


PRICES = Prices(
    speech_per_minute=0.016,
    reply_input_per_million=0.75,
    reply_cached_per_million=0.075,
    reply_output_per_million=3.75,
    voice_input_per_million=0.5,
    voice_output_per_million=9.0,
)


def test_turn_cost_adds_each_service() -> None:
    usage = TurnUsage(
        speech_billed_seconds=30,
        reply=Tokens(1_000_000, 2_000_000),
        voice=Tokens(2_000_000, 1_000_000),
    )
    cost = turn_cost(usage, PRICES)
    assert cost is not None
    assert cost.speech == pytest.approx(0.008)
    assert cost.reply == pytest.approx(8.25)
    assert cost.voice == pytest.approx(10.0)
    assert cost.total == pytest.approx(18.258)


def test_minute_cost_transcribes_every_participant() -> None:
    minute = meeting_minute_cost(
        TurnCost(speech=1.0, reply=0.002, voice=0.003),
        PRICES,
        participants=3,
        ai_turns_per_minute=2,
    )
    assert minute.speech == pytest.approx(0.048)
    assert minute.ai_turns == pytest.approx(0.01)
    assert minute.total == pytest.approx(0.058)


@pytest.mark.parametrize(("participants", "turns"), [(0, 1.0), (3, -1.0)])
def test_minute_cost_rejects_impossible_assumptions(participants: int, turns: float) -> None:
    with pytest.raises(ValueError):
        meeting_minute_cost(
            TurnCost(0, 0, 0), PRICES, participants=participants, ai_turns_per_minute=turns
        )
