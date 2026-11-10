import math
from collections.abc import Iterator

import pytest
from voice_samples import silence, speech

from classroom_agent.application.voice_check import (
    VOICE_STYLE,
    Exchange,
    RecognitionEvent,
    ReplyChunk,
    ReplyPrompt,
    VoiceCheckError,
    VoiceChunk,
    VoiceTurnRequest,
    VoiceTurnResult,
    build_reply_prompt,
    run_voice_turn,
)
from classroom_agent.domain.voice_check import PcmAudio
from classroom_agent.domain.voice_cost import Tokens


class Clock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class Recognizer:
    """Yield each event after the given number of chunks, or `delay` seconds after the audio."""

    def __init__(
        self,
        clock: Clock,
        script: list[tuple[int | None, RecognitionEvent]],
        *,
        delay: float = 0.4,
        read_all: bool = True,
        read_any: bool = True,
    ) -> None:
        self.clock = clock
        self.script = script
        self.delay = delay
        self.read_all = read_all
        self.read_any = read_any
        self.chunks: list[bytes] = []
        self.sample_rate = 0

    def recognize(self, chunks: Iterator[bytes], sample_rate: int) -> Iterator[RecognitionEvent]:
        self.sample_rate = sample_rate
        pending = list(self.script)
        for chunk in chunks if self.read_any else ():
            self.chunks.append(chunk)
            while pending and pending[0][0] == len(self.chunks):
                yield pending.pop(0)[1]
            if not self.read_all and len(self.chunks) == 3:
                break
        self.clock.now += self.delay
        for _, event in pending:
            yield event


class Writer:
    def __init__(self, clock: Clock, pieces: list[ReplyChunk], delay: float = 0.3) -> None:
        self.clock = clock
        self.pieces = pieces
        self.delay = delay
        self.prompts: list[ReplyPrompt] = []

    def write(self, prompt: ReplyPrompt) -> Iterator[ReplyChunk]:
        self.prompts.append(prompt)
        for piece in self.pieces:
            self.clock.now += self.delay
            yield piece


class Synthesizer:
    sample_rate = 24_000

    def __init__(self, clock: Clock, chunks: list[VoiceChunk], delay: float = 0.2) -> None:
        self.clock = clock
        self.chunks = chunks
        self.delay = delay
        self.calls: list[tuple[str, str]] = []

    def synthesize(self, text: str, style: str) -> Iterator[VoiceChunk]:
        self.calls.append((text, style))
        for chunk in self.chunks:
            self.clock.now += self.delay
            yield chunk


def request(audio: PcmAudio | None = None) -> VoiceTurnRequest:
    return VoiceTurnRequest(
        audio=audio or speech(spoken=1.0, after=0.5),
        topic="次の勉強会で読む本",
        member_name="ノト",
    )


def run(
    clock: Clock,
    *,
    recognizer: Recognizer | None = None,
    writer: Writer | None = None,
    synthesizer: Synthesizer | None = None,
    audio: PcmAudio | None = None,
) -> tuple[Recognizer, Writer, Synthesizer, VoiceTurnResult]:
    recognizer = recognizer or Recognizer(
        clock,
        [
            # Speech ends 1.0 s in; this first final arrives while it continues.
            (5, RecognitionEvent("ノト、", is_final=False)),
            (5, RecognitionEvent("ノト、", is_final=True)),
            (None, RecognitionEvent("どう思う？", is_final=True, billed_seconds=3.0)),
        ],
    )
    writer = writer or Writer(
        clock,
        [
            ReplyChunk("どの本が"),
            ReplyChunk("気になりますか？", Tokens(120, 40)),
        ],
    )
    synthesizer = synthesizer or Synthesizer(
        clock,
        [VoiceChunk(b"\x01\x00" * 10), VoiceChunk(b"\x02\x00" * 5, Tokens(12, 50))],
    )
    result = run_voice_turn(
        request(audio),
        recognizer=recognizer,
        writer=writer,
        synthesizer=synthesizer,
        clock=clock,
        sleep=clock.sleep,
    )
    return recognizer, writer, synthesizer, result


def test_one_turn_goes_from_speech_to_voice_in_order() -> None:
    clock = Clock()
    recognizer, writer, synthesizer, result = run(clock)

    assert result.transcript == "ノト、どう思う？"
    assert result.reply == "どの本が気になりますか？"
    assert writer.prompts[0].user == "ノト、どう思う？"
    assert synthesizer.calls == [("どの本が気になりますか？", VOICE_STYLE)]
    assert result.voice == PcmAudio(b"\x01\x00" * 10 + b"\x02\x00" * 5, 24_000)
    assert result.usage.speech_billed_seconds == 3.0
    assert result.usage.reply == Tokens(120, 40)
    assert result.usage.voice == Tokens(12, 50)

    timeline = result.timeline
    assert timeline.speech_ended == pytest.approx(101.0, abs=0.02)
    assert timeline.audio_sent == pytest.approx(104.5)
    assert timeline.transcript_final == pytest.approx(104.9)
    assert timeline.transcript_needed_stream_close
    assert timeline.reply_first_wait == pytest.approx(0.3)
    assert timeline.reply_wait == pytest.approx(0.6)
    assert timeline.first_audio_wait == pytest.approx(0.2)
    assert recognizer.sample_rate == 16_000


def test_audio_is_sent_at_real_time_speed_with_trailing_silence() -> None:
    clock = Clock()
    recognizer, *_ = run(clock)
    # 1.0 s of speech, 0.5 s recorded silence and 3.0 s added silence, in 0.1 s chunks.
    assert len(recognizer.chunks) == 45
    assert all(len(chunk) == 3_200 for chunk in recognizer.chunks)
    assert recognizer.chunks[-1] == bytes(3_200)
    assert sum(clock.sleeps) == pytest.approx(4.5)


def test_the_reply_starts_once_a_final_result_arrives_after_the_speech() -> None:
    clock = Clock()
    recognizer = Recognizer(
        clock,
        [
            (25, RecognitionEvent("こんにちは", is_final=True)),
            (30, RecognitionEvent("読まれない", is_final=True)),
        ],
    )
    *_, result = run(clock, recognizer=recognizer)
    assert result.transcript == "こんにちは"
    assert len(recognizer.chunks) == 25
    assert result.timeline.transcript_final == pytest.approx(102.5)
    assert math.isinf(result.timeline.audio_sent)
    assert not result.timeline.transcript_needed_stream_close
    assert result.usage.speech_billed_seconds == 3.0


def test_billed_seconds_fall_back_to_the_audio_sent() -> None:
    clock = Clock()
    recognizer = Recognizer(clock, [(None, RecognitionEvent("こんにちは", is_final=True))])
    *_, result = run(clock, recognizer=recognizer)
    assert result.usage.speech_billed_seconds == 5.0


def test_a_recognizer_that_stops_reading_early_is_not_flagged() -> None:
    clock = Clock()
    recognizer = Recognizer(
        clock, [(None, RecognitionEvent("こんにちは", is_final=True))], read_all=False
    )
    *_, result = run(clock, recognizer=recognizer)
    assert math.isinf(result.timeline.audio_sent)
    assert not result.timeline.transcript_needed_stream_close
    assert result.usage.speech_billed_seconds == 1.0


def test_markup_is_removed_from_the_spoken_reply() -> None:
    clock = Clock()
    writer = Writer(clock, [ReplyChunk("**どの本**が"), ReplyChunk("気になりますか？</h4>\n")])
    *_, result = run(clock, writer=writer)
    assert result.reply == "どの本が気になりますか？"
    assert result.usage.reply is None


def test_the_prompt_names_the_member_and_topic_and_asks_for_questions() -> None:
    prompt = build_reply_prompt(
        topic="次の勉強会で読む本", member_name="ノト", transcript="どう思う？"
    )
    assert "ノト" in prompt.context
    assert "次の勉強会で読む本" in prompt.context
    assert "問い" in prompt.system
    assert "これまでの会話" not in prompt.system
    assert prompt.user == "どう思う？"


def test_the_prompt_lists_earlier_utterances_in_order() -> None:
    prompt = build_reply_prompt(
        topic="お題",
        member_name="ノト",
        transcript="次は？",
        history=[Exchange("participant", "小説がいい"), Exchange("ai", "なぜですか？")],
    )
    assert prompt.history == (Exchange("participant", "小説がいい"), Exchange("ai", "なぜですか？"))
    assert all(item.text not in prompt.system for item in prompt.history)
    assert "お題" not in prompt.system and "ノト" not in prompt.system


@pytest.mark.parametrize(
    ("audio", "reason"),
    [
        (PcmAudio(silence(61.0, 8_000), 8_000), "audio_too_long"),
        (PcmAudio(silence(1.0), 16_000), "no_speech_in_audio"),
    ],
)
def test_unusable_input_stops_before_any_call(audio: PcmAudio, reason: str) -> None:
    clock = Clock()
    recognizer = Recognizer(clock, [])
    with pytest.raises(VoiceCheckError) as raised:
        run(clock, recognizer=recognizer, audio=audio)
    assert (raised.value.stage, raised.value.reason) == ("input", reason)
    assert recognizer.chunks == []


def test_empty_results_name_the_stage() -> None:
    clock = Clock()
    with pytest.raises(VoiceCheckError) as raised:
        run(clock, recognizer=Recognizer(clock, [(None, RecognitionEvent("  ", is_final=True))]))
    assert (raised.value.stage, raised.value.reason) == ("speech", "empty_transcript")

    with pytest.raises(VoiceCheckError) as raised:
        run(clock, writer=Writer(clock, [ReplyChunk(""), ReplyChunk(" ", Tokens(10, 1))]))
    assert (raised.value.stage, raised.value.reason) == ("reply", "empty_reply")

    with pytest.raises(VoiceCheckError) as raised:
        run(clock, synthesizer=Synthesizer(clock, [VoiceChunk(b"", Tokens(1, 0))]))
    assert (raised.value.stage, raised.value.reason) == ("voice", "empty_audio")

    with pytest.raises(VoiceCheckError) as raised:
        run(clock, synthesizer=Synthesizer(clock, [VoiceChunk(b"\x01")]))
    assert (raised.value.stage, raised.value.reason) == ("voice", "partial_sample")


class ProviderFailure(RuntimeError):
    pass


class FailingWriter(Writer):
    def write(self, prompt: ReplyPrompt) -> Iterator[ReplyChunk]:
        raise ProviderFailure("secret message from the provider")


class FailingSynthesizer(Synthesizer):
    def synthesize(self, text: str, style: str) -> Iterator[VoiceChunk]:
        yield VoiceChunk(b"\x01\x00")
        raise ProviderFailure("secret message from the provider")


def test_provider_failures_keep_the_stage_and_drop_the_message() -> None:
    clock = Clock()
    with pytest.raises(VoiceCheckError) as raised:
        run(clock, writer=FailingWriter(clock, []))
    assert (raised.value.stage, raised.value.reason) == ("reply", "ProviderFailure")
    assert "secret" not in str(raised.value)
    assert isinstance(raised.value.__cause__, ProviderFailure)

    with pytest.raises(VoiceCheckError) as raised:
        run(clock, synthesizer=FailingSynthesizer(clock, []))
    assert (raised.value.stage, raised.value.reason) == ("voice", "ProviderFailure")


def test_a_recognizer_that_never_reads_the_audio_is_an_error() -> None:
    clock = Clock()
    recognizer = Recognizer(clock, [(None, RecognitionEvent("幻", is_final=True))], read_any=False)
    with pytest.raises(VoiceCheckError) as raised:
        run(clock, recognizer=recognizer)
    assert (raised.value.stage, raised.value.reason) == ("speech", "audio_not_read")
