import asyncio
from collections.abc import AsyncGenerator
from dataclasses import replace
from unittest.mock import AsyncMock, MagicMock

import pytest

from classroom_agent.application.voice_probe import ProbeError, SpeechChunk, run_turn
from classroom_agent.domain.voice_cost import Tokens


async def stream(*chunks: SpeechChunk) -> AsyncGenerator[SpeechChunk, None]:
    for chunk in chunks:
        yield chunk


def test_turn_captions_latency_and_per_minute_cost_use_actual_audio_and_usage() -> None:
    providers = MagicMock()
    providers.reply_model = "gemini-3.8-flash"
    providers.reply_thinking = "low"
    providers.transcribe = AsyncMock(return_value="ノト、何を決めますか。")
    providers.reply = AsyncMock(return_value=("時間を決めませんか。", Tokens(100, 20, 10)))
    providers.synthesize.return_value = stream(
        SpeechChunk(b"\0" * 1920),
        SpeechChunk(usage=Tokens(10, 20)),
        SpeechChunk(usage=Tokens(10, 40)),
    )
    output = AsyncMock()
    times = iter([10.5, 11.5, 11.6, 12.6, 12.7, 13.7, 15.0])
    result = asyncio.run(
        run_turn(
            providers,
            output,
            b"\0" * 48_000,
            listening_at=5,
            speech_ended_at=10,
            clock=lambda: next(times),
        )
    )
    providers.reply.assert_awaited_once_with("ノト、何を決めますか。")
    assert [call.args for call in output.caption.await_args_list] == [
        ("user", "ノト、何を決めますか。"),
        ("ai", "時間を決めませんか。"),
    ]
    assert result.voice_latency_ms == 3700
    assert (result.stt_ms, result.gemini_ms, result.tts_first_ms) == (1000, 1000, 1000)
    assert result.endpoint_ms == 500
    assert output.play.await_count == 2
    assert result.stt_audio_s == 1.5
    expected = (2 * 0.016 / 60 + (90 * 0.75 + 10 * 0.075 + 20 * 3.75 + 10 * 0.5 + 40 * 9) / 1e6) * 6
    assert (result.reply_model, result.reply_thinking) == ("gemini-3.8-flash", "low")
    assert result.google_usd_per_min() == pytest.approx(expected)
    lite = replace(result, reply_model="gemini-3.5-flash-lite")
    lite_expected = (
        2 * 0.016 / 60 + (90 * 0.30 + 10 * 0.03 + 20 * 2.50 + 10 * 0.50 + 40 * 9) / 1e6
    ) * 6
    assert lite.google_usd_per_min() == pytest.approx(lite_expected)
    assert replace(result, tts_tokens=None).google_usd_per_min() is None
    assert replace(result, llm_tokens=None).google_usd_per_min() is None
    assert replace(result, window_s=0).google_usd_per_min() is None


@pytest.mark.parametrize("problem", ["stt", "no_speech", "gemini", "tts", "empty_audio"])
def test_stop_at_failed_stage_without_exposing_content(problem: str) -> None:
    providers = MagicMock()
    providers.reply_model = "gemini-3.8-flash"
    providers.reply_thinking = "low"
    providers.transcribe = AsyncMock(
        return_value="" if problem == "no_speech" else "private speech"
    )
    providers.reply = AsyncMock(return_value=("" if problem == "gemini" else "private reply", None))
    providers.synthesize.return_value = stream()
    if problem == "stt":
        providers.transcribe.side_effect = RuntimeError("private credentials")
    if problem == "tts":
        providers.synthesize.side_effect = RuntimeError("private reply")
    output = AsyncMock()
    with pytest.raises(ProbeError) as failure:
        asyncio.run(run_turn(providers, output, b"\0\0", listening_at=0, speech_ended_at=0))
    assert str(failure.value) == ("tts" if problem == "empty_audio" else problem)
    if problem in {"tts", "empty_audio"}:
        output.caption.assert_any_await("ai", "private reply")
    else:
        providers.synthesize.assert_not_called()
