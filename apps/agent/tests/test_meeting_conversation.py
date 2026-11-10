import asyncio
import time
from unittest.mock import AsyncMock

import pytest

from classroom_agent.application.meeting_conversation import Conversation, Listener, Utterance
from classroom_agent.application.voice_probe import ProbeError
from classroom_agent.domain.meeting_speech import END_GAP, FRAME_MS, LIMIT, PAD, Clip, Microphone


@pytest.mark.parametrize("gap", [True, False])
def test_long_audio_splits_byte_exactly_at_a_quiet_boundary(gap: bool) -> None:
    mic = Microphone()
    all_pcm = bytearray()
    clips = []
    for i in range(LIMIT + 500):
        value = (0 if gap else 650) if LIMIT - 210 <= i < LIMIT - 205 else 3000 + i % 37
        pcm = value.to_bytes(2, "little") * 320
        all_pcm.extend(pcm)
        clip = mic.feed(pcm, i * FRAME_MS / 1000)
        if clip:
            clips.append(clip)
    tail = mic.flush()
    assert tail
    clips.append(tail)
    assert len(clips) == 2 and b"".join(c.pcm for c in clips) == all_pcm
    assert LIMIT - 210 < len(clips[0].pcm) // 640 <= LIMIT - 205
    assert max(len(c.pcm) for c in clips) < 60 * 32000


def test_silence_and_one_short_acknowledgement() -> None:
    mic = Microphone()
    silence = bytes(640)
    voiced = (3000).to_bytes(2, "little") * 320
    for i in range(200):
        assert mic.feed(silence, i / 50) is None
    assert mic.feed(voiced, 4.0) is None
    clips = [mic.feed(silence, 4.0 + (i + 1) / 50) for i in range(END_GAP)]
    assert clips[-1] == Clip(silence * PAD + voiced + silence * PAD, 4.0, 4.0)
    assert mic.flush() is None


@pytest.mark.parametrize("signal_first", [True, False])
def test_signal_on_either_side_of_speech_uses_one_recognition(signal_first: bool) -> None:
    async def run() -> None:
        c = Conversation()
        transcribe = AsyncMock(side_effect=["まず、", "いくらですか？"])
        listener = Listener("B", c, transcribe)
        now = time.monotonic()
        try:
            c.add(Utterance("A", now - 3, now - 2, "三万円"))
            listener.submit(Clip(b"one", now - 0.2, now))
            await listener.queue.join()
            since = (now - 0.3 if signal_first else now + 0.1) - 0.4
            task = asyncio.create_task(listener.question(since, asyncio.Event()))
            await asyncio.sleep(0.06)
            assert not task.done()
            listener.submit(Clip(b"two", now + 0.05, now + 0.06))
            asked = await asyncio.wait_for(task, 2)
            assert len(asked) == 2 and transcribe.await_count == 2
            prompt = c.prompt(asked, {}, now + 1).text
            assert prompt.count("まず、いくらですか？") == 1 and prompt.count("三万円") == 1
            assert "三万円" not in Conversation().prompt(asked, {}, now + 1).text
        finally:
            await listener.close()

    asyncio.run(run())


def test_recognition_failure_is_safe_and_silence_cannot_start_a_turn() -> None:
    async def run() -> None:
        listener = Listener("B", Conversation(), AsyncMock(side_effect=ValueError("private")))
        try:
            with pytest.raises(ProbeError, match="no_speech"):
                await listener.question(time.monotonic() - 31, asyncio.Event())
            now = time.monotonic()
            listener.submit(Clip(b"x", now, now))
            with pytest.raises(ProbeError, match="stt"):
                await listener.question(now - 0.4, asyncio.Event())
        finally:
            await listener.close()

    asyncio.run(run())


def test_manual_finish_waits_for_pending_stt_and_excludes_later_background() -> None:
    async def run() -> None:
        ready = asyncio.Event()

        async def recognize(pcm: bytes) -> str:
            await ready.wait()
            return pcm.decode()

        listener = Listener("B", Conversation(), recognize)
        start = time.monotonic()
        finished = asyncio.Event()
        try:
            listener.submit(Clip(b"first", start, start))
            finished.set()
            task = asyncio.create_task(listener.question(start - 0.4, finished))
            await asyncio.sleep(0.3)
            assert not task.done()
            listener.submit(Clip(b"later", start + 0.3, start + 0.3))
            ready.set()
            assert [line.text for line in await task] == ["first"]
            await listener.queue.join()
            assert [line.text for line in listener.conversation.lines] == ["first", "later"]
        finally:
            await listener.close()

    asyncio.run(run())


def test_delayed_packets_do_not_split_a_word_and_slow_background_is_optional() -> None:
    async def run() -> None:
        c = Conversation()
        gate = asyncio.Event()

        async def recognize(_: bytes) -> str:
            await gate.wait()
            return "続き"

        listener = Listener("A", c, recognize)
        try:
            pcm = (3000).to_bytes(2, "little") * 320
            listener.feed(pcm, time.monotonic())
            await asyncio.sleep(0.4)
            listener.feed(pcm, time.monotonic())
            assert not c.lines
            listener.flush()  # mute or end of stream
            assert len(c.lines) == 1
            await c.wait_for_background(time.monotonic(), 0.01)
            assert c.lines[0].text is None
            waiting = asyncio.create_task(c.wait_for_background(time.monotonic()))
            gate.set()
            await waiting
            assert c.lines[0].text == "続き"
        finally:
            await listener.close()

    asyncio.run(run())
