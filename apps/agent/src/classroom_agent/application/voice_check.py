"""Run one voice turn: speech → transcript → reply text → AI voice and caption.

The steps wait for each other in order, as the product does, so the timings
show where the delay before the AI member speaks comes from.
"""

import math
import queue
import threading
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol, TypeVar

from classroom_agent.domain.voice_check import (
    SAMPLE_WIDTH_BYTES,
    PcmAudio,
    TurnTimeline,
    chunk_is_voiced,
    speech_end_seconds,
    spoken_text,
    turn_hold_seconds,
)
from classroom_agent.domain.voice_cost import Tokens, TurnUsage

Stage = Literal["input", "speech", "reply", "voice"]
MAX_INPUT_SECONDS = 60.0


class VoiceCheckError(Exception):
    """Name the failed stage and a fixed reason; never carry provider messages."""

    def __init__(self, stage: Stage, reason: str) -> None:
        self.stage = stage
        self.reason = reason
        super().__init__(f"{stage}: {reason}")


@dataclass(frozen=True, slots=True)
class RecognitionEvent:
    text: str
    is_final: bool
    billed_seconds: float | None = None


@dataclass(frozen=True, slots=True)
class ReplyChunk:
    text: str
    usage: Tokens | None = None


@dataclass(frozen=True, slots=True)
class VoiceChunk:
    pcm: bytes
    usage: Tokens | None = None


@dataclass(frozen=True, slots=True)
class Exchange:
    """One earlier utterance in the conversation, for context."""

    speaker: Literal["participant", "ai"]
    text: str


@dataclass(frozen=True, slots=True)
class ReplyPrompt:
    system: str
    user: str
    history: tuple[Exchange, ...] = ()
    context: str = ""


class SpeechRecognizer(Protocol):
    def recognize(self, chunks: Iterator[bytes], sample_rate: int) -> Iterator[RecognitionEvent]:
        """Stream audio while it arrives and yield recognition results."""
        ...


class ReplyWriter(Protocol):
    def write(self, prompt: ReplyPrompt) -> Iterator[ReplyChunk]:
        """Yield the reply text as it is generated; the last chunk may carry usage."""
        ...


class SpeechSynthesizer(Protocol):
    sample_rate: int

    def synthesize(self, text: str, style: str) -> Iterator[VoiceChunk]:
        """Yield mono 16-bit PCM as it is generated; the last chunk may carry usage."""
        ...


@dataclass(frozen=True, slots=True)
class VoiceTurnRequest:
    audio: PcmAudio
    topic: str
    member_name: str


@dataclass(frozen=True, slots=True)
class VoiceTurnResult:
    transcript: str
    reply: str
    voice: PcmAudio
    timeline: TurnTimeline
    usage: TurnUsage


# "Slowly" made a 58-character reply last 12 seconds on 2026-11-08, so ask for a natural pace.
VOICE_STYLE = "落ち着いた、やわらかい声で、自然な速さで話す。"


def build_reply_prompt(
    *, topic: str, member_name: str, transcript: str, history: Sequence[Exchange] = ()
) -> ReplyPrompt:
    """Instructions follow the AI member requirements in docs/app-requirements.md."""
    return ReplyPrompt(
        system=(
            "あなたはオンラインの話し合いに参加するAIメンバーです。"
            "参加者と同じ立場で、考えを深める問いか別の見方を日本語で返してください。"
            "議論の結論は参加者に委ねます。です・ます調で1〜2文、合わせて50文字以内。"
            "読み上げる文だけを返し、記号・箇条書き・絵文字・英字の略語・タグは使いません。"
            "外部の検索や作業を行う機能はありません。調査・実行済みと答えないでください。"
        ),
        user=transcript,
        history=tuple(history),
        context=f"AIの表示名：{member_name}" + (f"。話し合いのお題：{topic}" if topic else ""),
    )


T = TypeVar("T")


def _guard(stage: Stage, start: Callable[[], Iterator[T]]) -> Iterator[T]:
    """Convert provider failures into a stage name without their messages."""
    try:
        yield from start()
    except VoiceCheckError:
        raise
    except Exception as error:
        raise VoiceCheckError(stage, type(error).__name__) from error


def _chunks(audio: PcmAudio, chunk_seconds: float, trailing_silence_seconds: float) -> list[bytes]:
    size = max(SAMPLE_WIDTH_BYTES, round(audio.sample_rate * chunk_seconds) * SAMPLE_WIDTH_BYTES)
    silence = bytes(round(audio.sample_rate * trailing_silence_seconds) * SAMPLE_WIDTH_BYTES)
    pcm = audio.pcm + silence
    return [pcm[start : start + size] for start in range(0, len(pcm), size)]


def run_voice_turn(
    request: VoiceTurnRequest,
    *,
    recognizer: SpeechRecognizer,
    writer: ReplyWriter,
    synthesizer: SpeechSynthesizer,
    clock: Callable[[], float],
    sleep: Callable[[float], None],
    chunk_seconds: float = 0.1,
    trailing_silence_seconds: float = 3.0,
) -> VoiceTurnResult:
    """Feed recorded audio at real-time speed, then reply and synthesize the voice.

    Each chunk is sent once its audio would have been captured by a microphone,
    so the transcript wait matches a live call. Trailing silence lets the
    recognizer detect the end of speech itself instead of relying on the stream
    being closed; chirp_3 took 1.5 to 2 seconds to do so on 2026-11-08.

    As in a live room, the reply starts as soon as a final result arrives after
    the speech ended; the remaining silence is not sent.
    """
    audio = request.audio
    if audio.seconds > MAX_INPUT_SECONDS:
        raise VoiceCheckError("input", "audio_too_long")
    speech_end = speech_end_seconds(audio)
    if speech_end is None:
        raise VoiceCheckError("input", "no_speech_in_audio")

    started: list[float] = []
    sent: list[float] = []
    sent_bytes = [0]
    finished = [False]

    def seconds_of(byte_count: int) -> float:
        return byte_count / SAMPLE_WIDTH_BYTES / audio.sample_rate

    def paced() -> Iterator[bytes]:
        start = clock()
        started.append(start)
        for chunk in _chunks(audio, chunk_seconds, trailing_silence_seconds):
            delay = start + seconds_of(sent_bytes[0] + len(chunk)) - clock()
            if delay > 0:
                sleep(delay)
            if finished[0]:
                return
            yield chunk
            sent_bytes[0] += len(chunk)
        sent.append(clock())

    finals: list[str] = []
    transcript_final = 0.0
    billed_seconds = 0.0
    for event in _guard("speech", lambda: recognizer.recognize(paced(), audio.sample_rate)):
        if event.billed_seconds is not None:
            billed_seconds = event.billed_seconds
        if event.is_final and event.text.strip():
            finals.append(event.text.strip())
            transcript_final = clock()
            if started and transcript_final >= started[0] + speech_end:
                finished[0] = True
                break
    if not started:
        raise VoiceCheckError("speech", "audio_not_read")
    if not billed_seconds:
        # Speech-to-Text bills the audio it received, rounded up to whole seconds.
        billed_seconds = float(math.ceil(seconds_of(sent_bytes[0])))
    transcript = "".join(finals)
    if not transcript:
        raise VoiceCheckError("speech", "empty_transcript")

    prompt = build_reply_prompt(
        topic=request.topic, member_name=request.member_name, transcript=transcript
    )
    reply = _write_reply(writer, prompt, clock)
    voice = _speak(synthesizer, reply.text, clock)

    return VoiceTurnResult(
        transcript=transcript,
        reply=reply.text,
        voice=PcmAudio(voice.pcm, synthesizer.sample_rate),
        timeline=TurnTimeline(
            speech_ended=started[0] + speech_end,
            # The recognizer may stop reading before all audio is sent.
            audio_sent=sent[0] if sent else math.inf,
            transcript_final=transcript_final,
            reply_first_text=reply.first,
            reply_done=reply.done,
            first_audio=voice.first,
            audio_done=voice.done,
        ),
        usage=TurnUsage(billed_seconds, reply.usage, voice.usage),
    )


@dataclass(frozen=True, slots=True)
class _Reply:
    text: str
    first: float
    done: float
    usage: Tokens | None


def _write_reply(writer: ReplyWriter, prompt: ReplyPrompt, clock: Callable[[], float]) -> _Reply:
    parts: list[str] = []
    first = 0.0
    usage = None
    for piece in _guard("reply", lambda: writer.write(prompt)):
        if piece.text and not parts:
            first = clock()
        if piece.text:
            parts.append(piece.text)
        if piece.usage is not None:
            usage = piece.usage
    done = clock()
    text = spoken_text("".join(parts))
    if not text:
        raise VoiceCheckError("reply", "empty_reply")
    return _Reply(text, first, done, usage)


@dataclass(frozen=True, slots=True)
class _Voice:
    pcm: bytes
    first: float
    done: float
    usage: Tokens | None


def _speak(
    synthesizer: SpeechSynthesizer,
    text: str,
    clock: Callable[[], float],
    on_audio: Callable[[bytes], None] | None = None,
) -> _Voice:
    """Synthesize the reply; `on_audio` receives whole samples as soon as they arrive."""
    parts: list[bytes] = []
    first = 0.0
    usage = None
    carry = b""
    for chunk in _guard("voice", lambda: synthesizer.synthesize(text, VOICE_STYLE)):
        if chunk.pcm and not parts:
            first = clock()
        if chunk.pcm:
            parts.append(chunk.pcm)
            if on_audio is not None:
                data = carry + chunk.pcm
                whole = len(data) - len(data) % SAMPLE_WIDTH_BYTES
                carry = data[whole:]
                if whole:
                    on_audio(data[:whole])
        if chunk.usage is not None:
            usage = chunk.usage
    done = clock()
    pcm = b"".join(parts)
    if not pcm:
        raise VoiceCheckError("voice", "empty_audio")
    if len(pcm) % SAMPLE_WIDTH_BYTES:
        raise VoiceCheckError("voice", "partial_sample")
    return _Voice(pcm, first, done, usage)


class LiveAudio(Protocol):
    """Microphone audio that arrives while the participant talks."""

    def chunks(self) -> Iterator[bytes]:
        """Yield 16-bit mono PCM until the source is closed."""
        ...

    def close(self) -> None:
        """Stop the source; `chunks` then ends."""
        ...


class LiveTurnListener(Protocol):
    def heard(self, text: str) -> None:
        """The words recognized so far, while the participant may still be talking."""
        ...

    def transcript(self, text: str) -> None: ...

    def reply(self, text: str) -> None: ...

    def audio(self, pcm: bytes) -> None: ...


@dataclass(frozen=True, slots=True)
class LiveTurnResult:
    """Server-side waits in seconds, counted from the moment the turn was judged over.

    The browser measures from the end of speech.
    """

    transcript: str
    reply: str
    reply_first_wait: float
    reply_wait: float
    first_audio_wait: float
    usage: TurnUsage


# The recognizer may never finalize a sound it does not take for words, such as a cough
# after the last sentence. Stop waiting for that result after this many more seconds.
FINAL_RESULT_GRACE = 2.0
_READY = object()
_CLOSED = object()
_DONE = object()


class _Heard:
    """What the recognizer has finalized, and when the participant was last heard.

    The audio feeder and the recognizer's results run on different threads, so the
    shared values sit behind a lock.
    """

    def __init__(self, patience: float) -> None:
        self._lock = threading.Lock()
        self._patience = patience
        self._finals: list[str] = []
        self._last_final: float | None = None
        self._last_voice: float | None = None
        self._billed = 0.0
        self.received = 0
        self.decided = 0.0

    def voice(self, now: float) -> None:
        with self._lock:
            self._last_voice = now

    def final(self, text: str, now: float) -> str:
        with self._lock:
            self._finals.append(text)
            self._last_final = now
            return "".join(self._finals)

    def billed(self, seconds: float) -> None:
        with self._lock:
            self._billed = seconds

    def finished(self, now: float) -> bool:
        with self._lock:
            if self._last_final is None:
                return False
            hold = turn_hold_seconds("".join(self._finals)) * self._patience
            if self._last_voice is None:
                return now - self._last_final >= hold
            if self._last_voice > self._last_final:
                # Spoke again after the last final result: wait for those words too.
                return now - self._last_voice >= hold + FINAL_RESULT_GRACE
            return now - self._last_voice >= hold

    def result(self) -> tuple[str, float, float]:
        with self._lock:
            return "".join(self._finals), self.decided, self._billed


class LiveSession:
    """One browser conversation: turns in order, with the last few utterances as context."""

    def __init__(
        self,
        *,
        topic: str,
        member_name: str,
        recognizer: SpeechRecognizer,
        writer: ReplyWriter,
        synthesizer: SpeechSynthesizer,
        clock: Callable[[], float],
        max_turns: int = 30,
        history_size: int = 6,
        patience: float = 1.0,
    ) -> None:
        self._topic = topic
        self._member_name = member_name
        self._recognizer = recognizer
        self._writer = writer
        self._synthesizer = synthesizer
        self._clock = clock
        self._max_turns = max_turns
        self._patience = patience
        self._history: deque[Exchange] = deque(maxlen=history_size)
        self.turns = 0

    @property
    def voice_sample_rate(self) -> int:
        return self._synthesizer.sample_rate

    def turn(
        self, audio: LiveAudio, sample_rate: int, listener: LiveTurnListener
    ) -> LiveTurnResult:
        """Listen until the participant has finished, then reply in text and voice.

        The recognizer's final results only mark pauses, and people pause to think, so
        a final result alone does not end the turn. The turn ends once the words heard
        so far are final and the participant has been silent for a while; how long
        depends on how the words end (`turn_hold_seconds`). Audio is limited to 60
        seconds per turn, and the number of turns per session is capped so that a
        forgotten tab cannot run up costs.
        """
        if self.turns >= self._max_turns:
            audio.close()
            raise VoiceCheckError("input", "turn_limit")
        self.turns += 1
        heard = _Heard(self._patience)
        try:
            self._listen(audio, sample_rate, heard, listener)
        finally:
            audio.close()
        transcript, transcript_final, billed_seconds = heard.result()
        if not transcript:
            raise VoiceCheckError("speech", "empty_transcript")
        if not billed_seconds:
            billed_seconds = float(math.ceil(heard.received / SAMPLE_WIDTH_BYTES / sample_rate))
        listener.transcript(transcript)

        prompt = build_reply_prompt(
            topic=self._topic,
            member_name=self._member_name,
            transcript=transcript,
            history=self._history,
        )
        reply = _write_reply(self._writer, prompt, self._clock)
        listener.reply(reply.text)
        voice = _speak(self._synthesizer, reply.text, self._clock, listener.audio)

        self._history.extend((Exchange("participant", transcript), Exchange("ai", reply.text)))
        return LiveTurnResult(
            transcript=transcript,
            reply=reply.text,
            reply_first_wait=reply.first - transcript_final,
            reply_wait=reply.done - transcript_final,
            first_audio_wait=voice.first - reply.done,
            usage=TurnUsage(billed_seconds, reply.usage, voice.usage),
        )

    def _listen(
        self, audio: LiveAudio, sample_rate: int, heard: _Heard, listener: LiveTurnListener
    ) -> None:
        """Run the recognizer on its own thread and return once the turn has ended.

        The feeder checks the end of the turn each time a chunk arrives (every 100 ms
        from the browser), so no timer is needed. When the audio stops for another
        reason (the stop button or the 60-second limit), the recognizer still owes its
        last result, so this waits for the recognizer to finish instead.
        """
        inbox: queue.Queue[object] = queue.Queue()
        limit = round(MAX_INPUT_SECONDS * sample_rate) * SAMPLE_WIDTH_BYTES
        clock = self._clock

        def feed() -> Iterator[bytes]:
            for chunk in audio.chunks():
                heard.received += len(chunk)
                if chunk_is_voiced(chunk):
                    heard.voice(clock())
                yield chunk
                if heard.finished(clock()):
                    inbox.put(_READY)
                    return
                if heard.received >= limit:
                    break
            inbox.put(_CLOSED)

        def recognize() -> None:
            try:
                for event in self._recognizer.recognize(feed(), sample_rate):
                    if event.billed_seconds is not None:
                        heard.billed(event.billed_seconds)
                    if event.is_final and event.text.strip():
                        inbox.put(heard.final(event.text.strip(), clock()))
            except Exception as error:
                failure = VoiceCheckError("speech", type(error).__name__)
                failure.__cause__ = error
                inbox.put(failure)
            finally:
                inbox.put(_DONE)

        threading.Thread(target=recognize, daemon=True).start()
        while True:
            item = inbox.get()
            if item is _READY or item is _DONE:
                heard.decided = clock()
                return
            if isinstance(item, VoiceCheckError):
                raise item
            if isinstance(item, str):
                listener.heard(item)
