"""Run one measured Japanese voice turn. Media and captions live only in memory."""

import math
import time
from collections.abc import AsyncGenerator, Callable
from contextlib import aclosing
from dataclasses import dataclass
from typing import Literal, Protocol

from classroom_agent.domain.voice_cost import Tokens, TurnUsage, prices_for_models, turn_cost

PROBE_SPEECH_MODEL = "chirp_3"
PROBE_TTS_MODEL = "gemini-3.8-flash-tts"
PROBE_VERTEX_LOCATION = "global"
INPUT_RATE = 16_000
OUTPUT_RATE = 24_000
Speaker = Literal["user", "ai"]


@dataclass(frozen=True)
class SpeechChunk:
    pcm: bytes = b""
    usage: Tokens | None = None


class Providers(Protocol):
    reply_model: str
    reply_thinking: str

    async def transcribe(self, pcm: bytes) -> str: ...
    async def reply(self, transcript: str) -> tuple[str, Tokens | None]: ...
    def synthesize(self, text: str) -> AsyncGenerator[SpeechChunk, None]: ...


class Output(Protocol):
    async def caption(self, speaker: Speaker, text: str) -> None: ...
    async def play(self, pcm: bytes) -> None: ...
    async def drain(self) -> None: ...


class ProbeError(Exception):
    """Only the fixed stage name may leave the worker."""

    def __init__(self, stage: str) -> None:
        self.stage = stage
        super().__init__(stage)


@dataclass(frozen=True)
class Measurement:
    reply_model: str
    reply_thinking: str
    window_s: float
    stt_audio_s: float
    endpoint_ms: int
    stt_ms: int
    gemini_ms: int
    tts_first_ms: int
    voice_latency_ms: int
    llm_tokens: Tokens | None
    tts_tokens: Tokens | None

    def google_usd_per_min(self) -> float | None:
        if self.window_s <= 0:
            return None
        prices = prices_for_models(
            speech_model=PROBE_SPEECH_MODEL,
            reply_model=self.reply_model,
            reply_location=PROBE_VERTEX_LOCATION,
            tts_model=PROBE_TTS_MODEL,
        )
        usage = TurnUsage(math.ceil(self.stt_audio_s), self.llm_tokens, self.tts_tokens)
        cost = turn_cost(usage, prices)
        return cost.total * 60 / self.window_s if cost else None


@dataclass(frozen=True)
class SpokenReply:
    text: str
    llm_usage: Tokens | None
    tts_usage: Tokens | None
    llm_ms: int
    tts_first_ms: int
    first_frame_at: float


async def speak_reply(
    providers: Providers, output: Output, prompt: str, clock: Callable[[], float] = time.monotonic
) -> SpokenReply:
    llm_started = clock()
    try:
        reply, llm_usage = await providers.reply(prompt)
        if not reply.strip():
            raise ProbeError("gemini")
    except Exception:
        raise ProbeError("gemini") from None
    llm_ms = round((clock() - llm_started) * 1000)
    return await speak_text(providers, output, reply, clock, llm_usage, llm_ms)


async def speak_text(
    providers: Providers,
    output: Output,
    reply: str,
    clock: Callable[[], float] = time.monotonic,
    llm_usage: Tokens | None = None,
    llm_ms: int = 0,
) -> SpokenReply:
    try:
        # Emit the full reply before synthesis, including when TTS fails or times out.
        await output.caption("ai", reply)
        tts_started = clock()
        first_frame = None
        tts_usage = None
        frame_bytes = OUTPUT_RATE * 2 // 50  # 20 ms of mono PCM16
        async with aclosing(providers.synthesize(reply)) as stream:
            async for chunk in stream:
                if chunk.usage is not None:
                    tts_usage = chunk.usage  # Vertex reports cumulative request usage.
                for pos in range(0, len(chunk.pcm), frame_bytes):
                    await output.play(chunk.pcm[pos : pos + frame_bytes])
                    if first_frame is None:
                        first_frame = clock()
        if first_frame is None:
            raise ProbeError("tts")
        await output.drain()
        return SpokenReply(
            reply,
            llm_usage,
            tts_usage,
            llm_ms,
            round((first_frame - tts_started) * 1000),
            first_frame,
        )
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("tts") from None


async def run_turn(
    providers: Providers,
    output: Output,
    pcm: bytes,
    *,
    listening_at: float,
    speech_ended_at: float,
    clock: Callable[[], float] = time.monotonic,
) -> Measurement:
    """End of speech to first frame accepted for publication, all on the worker clock."""
    stt_started = clock()
    stage = "stt"
    try:
        transcript = (await providers.transcribe(pcm)).strip()
        if not transcript:
            raise ProbeError("no_speech")
        stt_finished = clock()
        await output.caption("user", transcript)
        stage = "gemini"
        reply = await speak_reply(providers, output, transcript, clock)
    except ProbeError:
        raise
    except Exception:
        raise ProbeError(stage) from None

    return Measurement(
        reply_model=providers.reply_model,
        reply_thinking=providers.reply_thinking,
        window_s=clock() - listening_at,
        stt_audio_s=len(pcm) / (2 * INPUT_RATE),
        endpoint_ms=round((stt_started - speech_ended_at) * 1000),
        stt_ms=round((stt_finished - stt_started) * 1000),
        gemini_ms=reply.llm_ms,
        tts_first_ms=reply.tts_first_ms,
        voice_latency_ms=round((reply.first_frame_at - speech_ended_at) * 1000),
        llm_tokens=reply.llm_usage,
        tts_tokens=reply.tts_usage,
    )
