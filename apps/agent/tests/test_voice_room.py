import asyncio
from collections.abc import AsyncGenerator, Callable
from typing import TypeVar, cast
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from livekit import rtc
from livekit.agents import JobContext, JobRequest, vad

from classroom_agent.application.voice_probe import ProbeError, SpeechChunk
from classroom_agent.infrastructure import voice_room
from classroom_agent.infrastructure.voice_room import (
    SPEAKER,
    accept_probe,
    bounded_job,
    listen_once,
    run_probe_room,
)

T = TypeVar("T")


async def items(*values: T) -> AsyncGenerator[T, None]:
    for value in values:
        yield value


def test_only_probe_rooms_can_dispatch_the_worker() -> None:
    request = AsyncMock(spec=JobRequest)
    request.room.name = "production"
    asyncio.run(accept_probe(request))
    request.reject.assert_awaited_once()
    request.room.name = "voice-probe-bc39ea3e-bf54-4017-88ee-c662191ada3c"
    asyncio.run(accept_probe(request))
    request.accept.assert_awaited_once_with(name="ノト", identity=voice_room.AGENT_NAME)


@pytest.mark.parametrize("duration", [0, 0.6, 19.8, 20.1, 24])
def test_listen_consumes_a_bounded_utterance_and_stops_the_audio_pump(duration: float) -> None:
    async def check() -> None:
        frame = rtc.AudioFrame(b"\0" * 320, 16000, 1, 160)
        audio = MagicMock()
        audio.__aiter__.return_value = [MagicMock(frame=frame)]
        detector = MagicMock()

        async def detect() -> AsyncGenerator[MagicMock, None]:
            await asyncio.sleep(0)  # let the producer finish the track
            if duration:
                yield MagicMock(type=vad.VADEventType.START_OF_SPEECH, speech_duration=0.05)
                yield MagicMock(
                    type=vad.VADEventType.INFERENCE_DONE,
                    speech_duration=duration + 1.7,
                )
                yield MagicMock(
                    type=vad.VADEventType.END_OF_SPEECH,
                    speech_duration=duration,
                    silence_duration=1.8,
                    frames=[frame],
                )

        detector.__aiter__.side_effect = detect
        if 0 < duration <= 20:
            pcm, _end = await listen_once(audio, detector)
            assert pcm == frame.data.tobytes()
        else:
            with pytest.raises(ProbeError, match="no_speech|too_long"):
                await listen_once(audio, detector)
        detector.push_frame.assert_called_once_with(frame)
        detector.end_input.assert_called_once()

    asyncio.run(check())


@pytest.mark.parametrize("failure", ["", "provider", "setup"])
def test_room_publishes_private_captions_and_only_numeric_results_or_a_stage(failure: str) -> None:
    async def check() -> None:
        ctx = MagicMock(spec=JobContext)
        ctx.connect = AsyncMock()
        ctx.wait_for_participant = AsyncMock()
        local = ctx.room.local_participant
        local.publish_data = AsyncMock()
        local.publish_track = AsyncMock()
        services = MagicMock()
        services.reply_model = "gemini-3.5-flash-lite"
        services.reply_thinking = "default"
        services.transcribe = AsyncMock(return_value="試験用の質問")
        services.reply = AsyncMock(return_value=("試験用の答え", None))
        services.synthesize.return_value = items(SpeechChunk(b"\0" * 960))
        if failure == "provider":
            services.synthesize.side_effect = ValueError("sensitive value")
        with (
            patch.object(voice_room, "listen_once", new=AsyncMock(return_value=(b"\0" * 320, 1.0))),
            patch("livekit.plugins.silero.VAD.load") as load_vad,
            patch.object(rtc.AudioStream, "from_participant") as audio,
            patch.object(rtc, "AudioSource") as source,
            patch.object(rtc.LocalAudioTrack, "create_audio_track"),
        ):
            audio.return_value.aclose = AsyncMock()
            source.return_value.aclose = AsyncMock()
            source.return_value.capture_frame = AsyncMock()
            source.return_value.wait_for_playout = AsyncMock()
            load_vad.return_value.stream.return_value.aclose = AsyncMock()
            if failure == "setup":
                load_vad.side_effect = RuntimeError("sensitive value")
            await run_probe_room(ctx, lambda _: services)
            assert load_vad.call_args.kwargs["min_silence_duration"] == 1.8
            ctx.init_recording.assert_called_once_with(
                dict(audio=False, logs=False, traces=False, transcript=False)
            )
            packets = local.publish_data.await_args_list
            assert all(p.kwargs["destination_identities"] == [SPEAKER] for p in packets)
            assert "sensitive value" not in str(packets)
            last_packet = packets[-1].args[0]
            assert "試験用" not in last_packet
            if failure:
                assert (
                    '"stage": "tts"' in last_packet
                    if failure == "provider"
                    else '"stage": "setup"' in last_packet
                )
            else:
                assert '"type": "result"' in last_packet
                assert '"reply_model": "gemini-3.5-flash-lite"' in last_packet
                assert '"reply_thinking": "default"' in last_packet
                assert "試験用の質問" in packets[1].args[0]
                assert "試験用の答え" in packets[2].args[0]
                source.return_value.capture_frame.assert_awaited_once()
            source.return_value.aclose.assert_awaited_once()

    asyncio.run(check())


@pytest.mark.parametrize("exit_reason", ["left", "timeout", "done"])
def test_service_calls_end_on_departure_or_deadline(
    exit_reason: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def check() -> None:
        ctx = MagicMock()
        ctx.room.local_participant.publish_data = AsyncMock()

        async def work() -> None:
            left = cast(Callable[[rtc.RemoteParticipant], None], ctx.room.on.call_args.args[1])
            left(MagicMock(identity="someone-else"))
            if exit_reason == "left":
                left(MagicMock(identity=SPEAKER))
            if exit_reason != "done":
                await asyncio.Event().wait()

        monkeypatch.setattr(voice_room, "MAX_ROOM_S", 0.02)
        if exit_reason == "left":
            with pytest.raises(asyncio.CancelledError):
                await bounded_job(ctx, work)
        else:
            await bounded_job(ctx, work)
        assert ctx.room.local_participant.publish_data.await_count == int(exit_reason == "timeout")
        ctx.room.off.assert_called_once()
        ctx.shutdown.assert_called_once()

    asyncio.run(check())
