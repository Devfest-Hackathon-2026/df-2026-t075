"""Live turns: when the participant has finished, and what happens next.

Chunks are 0.25 s of 16 kHz audio, and the fake microphone moves the clock as each
chunk arrives, as a real one would. Quarter seconds keep the arithmetic exact.
"""

from collections.abc import Iterator

import pytest
from voice_samples import tone

from classroom_agent.application.voice_check import (
    LiveSession,
    RecognitionEvent,
    ReplyChunk,
    ReplyPrompt,
    VoiceCheckError,
    VoiceChunk,
)
from classroom_agent.domain.voice_cost import Tokens

STEP = 0.25
VOICE = tone(STEP)
SILENCE = bytes(len(VOICE))


class Clock:
    def __init__(self) -> None:
        self.now = 50.0

    def __call__(self) -> float:
        return self.now


class Microphone:
    """Deliver chunks in real time; `close` records that listening stopped."""

    def __init__(self, clock: Clock, pattern: str) -> None:
        # "v" is a chunk with a voice, "." a silent one.
        self.clock = clock
        self.pattern = pattern
        self.read = 0
        self.closed = False

    def chunks(self) -> Iterator[bytes]:
        for mark in self.pattern:
            if self.closed:
                return
            self.clock.now += STEP
            self.read += 1
            yield VOICE if mark == "v" else SILENCE

    def close(self) -> None:
        self.closed = True


class Recognizer:
    """Yield each event after the given number of chunks, or after the audio ends (None)."""

    def __init__(self, script: list[tuple[int | None, RecognitionEvent]]) -> None:
        self.script = script

    def recognize(self, chunks: Iterator[bytes], sample_rate: int) -> Iterator[RecognitionEvent]:
        assert sample_rate == 16_000
        pending = list(self.script)
        for count, _ in enumerate(chunks, start=1):
            while pending and pending[0][0] == count:
                yield pending.pop(0)[1]
        for _, event in pending:
            yield event


def final(text: str, billed: float | None = None) -> RecognitionEvent:
    return RecognitionEvent(text, is_final=True, billed_seconds=billed)


class FailingRecognizer:
    def recognize(self, chunks: Iterator[bytes], sample_rate: int) -> Iterator[RecognitionEvent]:
        next(chunks)
        raise ConnectionResetError("secret detail")


class Writer:
    def __init__(self, clock: Clock, replies: list[str] | None = None) -> None:
        self.clock = clock
        self.replies = replies or ["どの本ですか？"] * 5
        self.prompts: list[ReplyPrompt] = []

    def write(self, prompt: ReplyPrompt) -> Iterator[ReplyChunk]:
        self.prompts.append(prompt)
        self.clock.now += 0.5
        yield ReplyChunk(self.replies[len(self.prompts) - 1], Tokens(100, 20))
        self.clock.now += 0.25


class Synthesizer:
    sample_rate = 24_000

    def __init__(self, clock: Clock) -> None:
        self.clock = clock

    def synthesize(self, text: str, style: str) -> Iterator[VoiceChunk]:
        self.clock.now += 0.75
        yield VoiceChunk(b"\x01\x00\x02")
        yield VoiceChunk(b"\x00\x03\x00", Tokens(10, 30))


class Listener:
    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []

    def heard(self, text: str) -> None:
        self.events.append(("heard", text))

    def transcript(self, text: str) -> None:
        self.events.append(("transcript", text))

    def reply(self, text: str) -> None:
        self.events.append(("reply", text))

    def audio(self, pcm: bytes) -> None:
        self.events.append(("audio", pcm))


def session(clock: Clock, recognizer: object, **kwargs: float) -> tuple[LiveSession, Writer]:
    writer = Writer(clock)
    live = LiveSession(
        topic="お題",
        member_name="ノト",
        recognizer=recognizer,  # type: ignore[arg-type]
        writer=writer,
        synthesizer=Synthesizer(clock),
        clock=clock,
        **kwargs,  # type: ignore[arg-type]
    )
    return live, writer


def test_a_finished_question_is_answered_after_a_short_silence() -> None:
    clock = Clock()
    live, _ = session(clock, Recognizer([(6, final("どう思う？"))]))
    microphone = Microphone(clock, "vvvv" + "." * 30)
    listener = Listener()

    result = live.turn(microphone, 16_000, listener)

    # The voice stops at 51.0; "？" needs 0.8 s of silence, first reached at 52.0.
    assert microphone.read == 8
    assert microphone.closed
    assert listener.events == [
        ("heard", "どう思う？"),
        ("transcript", "どう思う？"),
        ("reply", "どの本ですか？"),
        ("audio", b"\x01\x00"),
        ("audio", b"\x02\x00\x03\x00"),
    ]
    assert result.reply_first_wait == pytest.approx(0.5)
    assert result.reply_wait == pytest.approx(0.75)
    assert result.first_audio_wait == pytest.approx(0.75)
    assert result.usage.speech_billed_seconds == 2.0
    assert live.voice_sample_rate == 24_000


def test_a_pause_to_think_does_not_end_the_turn() -> None:
    clock = Clock()
    live, writer = session(
        clock,
        Recognizer([(7, final("えーと、次に読む本は")), (16, final("どうしましょうか？"))]),
    )
    # Speaks, pauses 1.25 s mid-sentence, then finishes the question.
    microphone = Microphone(clock, "vvvv" + "....." + "vvvv" + "." * 30)
    listener = Listener()

    result = live.turn(microphone, 16_000, listener)

    assert result.transcript == "えーと、次に読む本はどうしましょうか？"
    assert writer.prompts[0].user == result.transcript
    assert listener.events[:2] == [
        ("heard", "えーと、次に読む本は"),
        ("heard", "えーと、次に読む本はどうしましょうか？"),
    ]
    assert microphone.read == 17


def test_a_sound_after_the_last_result_is_waited_out_but_not_forever() -> None:
    clock = Clock()
    live, _ = session(clock, Recognizer([(5, final("どう思う？"))]))
    # A cough right after the question, which the recognizer never turns into words.
    microphone = Microphone(clock, "vvvv" + "." + "v" + "." * 40)
    live.turn(microphone, 16_000, Listener())
    # Last sound at 51.5, then 0.8 s plus 2 s of grace: ends at 54.5.
    assert microphone.read == 18


def test_patience_stretches_the_silence() -> None:
    clock = Clock()
    live, _ = session(clock, Recognizer([(6, final("どう思う？"))]), patience=2.0)
    microphone = Microphone(clock, "vvvv" + "." * 30)
    live.turn(microphone, 16_000, Listener())
    assert microphone.read == 11


def test_when_the_audio_stops_the_last_result_is_still_used() -> None:
    clock = Clock()
    live, _ = session(clock, Recognizer([(None, final("途中までの話", billed=3.0))]))
    microphone = Microphone(clock, "vvvv.")
    result = live.turn(microphone, 16_000, Listener())
    assert result.transcript == "途中までの話"
    assert result.usage.speech_billed_seconds == 3.0


def test_later_turns_see_the_earlier_conversation_and_old_lines_drop_off() -> None:
    clock = Clock()
    live, writer = session(clock, Recognizer([(None, final("話した"))]), history_size=2)
    writer.replies = ["一つ目", "二つ目", "三つ目"]
    for _ in range(3):
        live.turn(Microphone(clock, "vv"), 16_000, Listener())

    assert writer.prompts[0].history == ()
    assert [e.text for e in writer.prompts[1].history] == ["話した", "一つ目"]
    assert [e.text for e in writer.prompts[2].history] == ["話した", "二つ目"]
    assert live.turns == 3


def test_zero_history_keeps_turns_independent() -> None:
    clock = Clock()
    live, writer = session(clock, Recognizer([(None, final("話した"))]), history_size=0)
    writer.replies = ["一つ目", "二つ目"]
    for _ in range(2):
        live.turn(Microphone(clock, "vv"), 16_000, Listener())
    assert all(prompt.history == () for prompt in writer.prompts)


def test_audio_is_limited_to_sixty_seconds_per_turn() -> None:
    clock = Clock()
    live, _ = session(clock, Recognizer([(None, final("長い話"))]))
    microphone = Microphone(clock, "v" * 300)
    live.turn(microphone, 16_000, Listener())
    assert microphone.read == 240


def test_silence_failures_and_the_turn_limit_are_errors() -> None:
    clock = Clock()
    live, _ = session(clock, Recognizer([(None, final("  "))]), max_turns=2)
    microphone = Microphone(clock, "..")
    with pytest.raises(VoiceCheckError) as raised:
        live.turn(microphone, 16_000, Listener())
    assert (raised.value.stage, raised.value.reason) == ("speech", "empty_transcript")
    assert microphone.closed

    broken, _ = session(clock, FailingRecognizer())
    with pytest.raises(VoiceCheckError) as raised:
        broken.turn(Microphone(clock, "vv"), 16_000, Listener())
    assert (raised.value.stage, raised.value.reason) == ("speech", "ConnectionResetError")
    assert "secret" not in str(raised.value)

    live.turns = 2
    blocked = Microphone(clock, "v")
    with pytest.raises(VoiceCheckError) as raised:
        live.turn(blocked, 16_000, Listener())
    assert (raised.value.stage, raised.value.reason) == ("input", "turn_limit")
    assert blocked.closed and blocked.read == 0
