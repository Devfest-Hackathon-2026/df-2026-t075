"""Transport for a private, single-speaker measurement room."""

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, aclosing
from dataclasses import asdict

from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, JobRequest, vad
from livekit.plugins import silero  # LiveKit registers plugins on the worker's main thread.

from classroom_agent.application.voice_probe import (
    INPUT_RATE,
    OUTPUT_RATE,
    ProbeError,
    Providers,
    Speaker,
    run_turn,
)

AGENT_NAME = "ainote-voice-probe"
SPEAKER = "probe-speaker"
TOPIC = "ainote.voice-probe.v1"
MAX_SPEECH_S = 20
END_SILENCE_S = 1.8
MAX_ROOM_S = 90


async def accept_probe(request: JobRequest) -> None:
    if re.fullmatch(r"voice-probe-[0-9a-f-]{36}", request.room.name):
        await request.accept(name="ノト", identity=AGENT_NAME)
    else:
        await request.reject()


class RoomOutput:
    def __init__(
        self,
        participant: rtc.LocalParticipant,
        source: rtc.AudioSource,
        *,
        topic: str = TOPIC,
        destinations: tuple[str, ...] = (SPEAKER,),
    ) -> None:
        self.participant = participant
        self.source = source
        self.topic = topic
        self.destinations = destinations

    async def send(self, payload: dict[str, object]) -> None:
        await self.participant.publish_data(
            json.dumps(payload, ensure_ascii=False),
            reliable=True,
            topic=self.topic,
            destination_identities=list(self.destinations),
        )

    async def caption(self, speaker: Speaker, text: str) -> None:
        await self.send({"type": "caption", "speaker": speaker, "text": text})

    async def play(self, pcm: bytes) -> None:
        await self.source.capture_frame(rtc.AudioFrame(pcm, OUTPUT_RATE, 1, len(pcm) // 2))

    async def drain(self) -> None:
        await self.source.wait_for_playout()


async def listen_once(audio: rtc.AudioStream, detector: vad.VADStream) -> tuple[bytes, float]:
    async def feed() -> None:
        try:
            async for packet in audio:
                detector.push_frame(packet.frame)
        finally:
            detector.end_input()

    task = asyncio.create_task(feed())
    try:
        async for event in detector:
            if event.type == vad.VADEventType.END_OF_SPEECH:
                # Silero subtracts trailing silence from this final duration.
                if event.speech_duration > MAX_SPEECH_S:
                    raise ProbeError("too_long")
                ended = time.monotonic() - event.silence_duration
                return rtc.combine_audio_frames(event.frames).data.tobytes(), ended
            # Intermediate durations still include a possible end-of-turn pause.
            if event.speech_duration > MAX_SPEECH_S + END_SILENCE_S:
                raise ProbeError("too_long")
        raise ProbeError("no_speech")
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def run_probe_room(
    ctx: JobContext,
    open_providers: Callable[[AsyncExitStack], Providers],
) -> None:
    ctx.init_recording({"audio": False, "transcript": False, "logs": False, "traces": False})
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    participant = await ctx.wait_for_participant(identity=SPEAKER)
    async with AsyncExitStack() as stack:
        source = await stack.enter_async_context(aclosing(rtc.AudioSource(OUTPUT_RATE, 1)))
        output = RoomOutput(ctx.room.local_participant, source)
        track = rtc.LocalAudioTrack.create_audio_track("ノト", source)
        await ctx.room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )
        try:
            providers = open_providers(stack)
            detector = silero.VAD.load(
                min_silence_duration=END_SILENCE_S,
                max_buffered_speech=MAX_SPEECH_S + END_SILENCE_S + 1,
            ).stream()
            async with (
                aclosing(detector),
                aclosing(
                    rtc.AudioStream.from_participant(
                        participant=participant,
                        track_source=rtc.TrackSource.SOURCE_MICROPHONE,
                        sample_rate=INPUT_RATE,
                        num_channels=1,
                    )
                ) as audio,
            ):
                await output.send({"type": "ready"})
                listening_at = time.monotonic()
                pcm, ended = await listen_once(audio, detector)
            result = await run_turn(
                providers, output, pcm, listening_at=listening_at, speech_ended_at=ended
            )
            await output.send(
                {
                    "type": "result",
                    **asdict(result),
                    "google_usd_per_min": result.google_usd_per_min(),
                }
            )
        except ProbeError as error:
            await output.send({"type": "error", "stage": error.stage})
        except Exception:
            await output.send({"type": "error", "stage": "setup"})


async def bounded_job(ctx: JobContext, run: Callable[[], Awaitable[None]]) -> None:
    # Client departure cancels provider work even while waiting for Gemini/TTS.
    task = asyncio.ensure_future(run())

    def left(participant: rtc.RemoteParticipant) -> None:
        if participant.identity == SPEAKER:
            task.cancel()

    ctx.room.on("participant_disconnected", left)
    try:
        async with asyncio.timeout(MAX_ROOM_S):
            await task
    except TimeoutError:
        await ctx.room.local_participant.publish_data(
            '{"type":"error","stage":"timeout"}',
            topic=TOPIC,
            reliable=True,
            destination_identities=[SPEAKER],
        )
    finally:
        ctx.room.off("participant_disconnected", left)
        ctx.shutdown("probe finished")
