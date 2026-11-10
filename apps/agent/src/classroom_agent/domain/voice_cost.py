"""Google inference costs for the local and LiveKit voice measurements."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Tokens:
    """Cumulative request usage.

    Cached input is already included in prompt, and thinking in output. The two
    breakdowns are kept so that a slow reply can be traced to its thinking.
    """

    prompt: int
    output: int
    cached: int = 0
    thoughts: int = 0


@dataclass(frozen=True, slots=True)
class TurnUsage:
    speech_billed_seconds: float
    reply: Tokens | None
    voice: Tokens | None


@dataclass(frozen=True, slots=True)
class Prices:
    """USD prices. Output tokens of the reply include thinking tokens."""

    speech_per_minute: float
    reply_input_per_million: float
    reply_cached_per_million: float
    reply_output_per_million: float
    voice_input_per_million: float
    voice_output_per_million: float


# USD list prices from the 2026-11-08 measurement. See docs/voice-probe.md.
# (input, cached input, output) per million tokens, by Vertex location.
_REPLY_RATES = {
    "gemini-3.8-flash": {"global": (0.75, 0.075, 3.75), "regional": (0.825, 0.0825, 4.125)},
    "gemini-3.5-flash-lite": {"global": (0.30, 0.03, 2.50), "regional": (0.33, 0.033, 2.75)},
}
_TTS_RATES = {
    "gemini-3.8-flash-tts": (0.50, 9.00),
    "gemini-3.8-flash-lite-tts": (0.50, 6.00),
}
_STANDARD_SPEECH = {"chirp_3", "chirp_2", "chirp", "long", "short", "latest_long", "latest_short"}


def prices_for_models(
    *, speech_model: str, reply_model: str, reply_location: str, tts_model: str
) -> Prices | None:
    reply = _REPLY_RATES.get(reply_model)
    voice = _TTS_RATES.get(tts_model)
    if speech_model not in _STANDARD_SPEECH or reply is None or voice is None:
        return None
    input_rate, cached, output = reply["global" if reply_location == "global" else "regional"]
    return Prices(
        speech_per_minute=0.016,
        reply_input_per_million=input_rate,
        reply_cached_per_million=cached,
        reply_output_per_million=output,
        voice_input_per_million=voice[0],
        voice_output_per_million=voice[1],
    )


@dataclass(frozen=True, slots=True)
class TurnCost:
    speech: float
    reply: float
    voice: float

    @property
    def total(self) -> float:
        return self.speech + self.reply + self.voice


def turn_cost(usage: TurnUsage, prices: Prices | None) -> TurnCost | None:
    reply, voice = usage.reply, usage.voice
    if prices is None or reply is None or voice is None:
        return None
    million = 1_000_000
    return TurnCost(
        speech=usage.speech_billed_seconds / 60 * prices.speech_per_minute,
        reply=(
            (reply.prompt - reply.cached) * prices.reply_input_per_million
            + reply.cached * prices.reply_cached_per_million
            + reply.output * prices.reply_output_per_million
        )
        / million,
        voice=(
            voice.prompt * prices.voice_input_per_million
            + voice.output * prices.voice_output_per_million
        )
        / million,
    )


@dataclass(frozen=True, slots=True)
class MinuteCost:
    speech: float
    ai_turns: float

    @property
    def total(self) -> float:
        return self.speech + self.ai_turns


def meeting_minute_cost(
    cost: TurnCost, prices: Prices, *, participants: int, ai_turns_per_minute: float
) -> MinuteCost:
    """Estimate one meeting minute.

    Every participant's audio is transcribed for the whole minute, and the AI
    member speaks `ai_turns_per_minute` times at the measured reply and voice
    cost. Gemini calls for memos and agenda drafts are not included.
    """
    if participants < 1:
        raise ValueError("participants must be at least 1")
    if ai_turns_per_minute < 0:
        raise ValueError("ai_turns_per_minute must not be negative")
    return MinuteCost(
        speech=participants * prices.speech_per_minute,
        ai_turns=ai_turns_per_minute * (cost.reply + cost.voice),
    )
