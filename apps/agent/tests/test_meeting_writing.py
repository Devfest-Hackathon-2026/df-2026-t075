import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import pytest

from classroom_agent.application.meeting_conversation import HISTORY_CHARS, Conversation, Utterance
from classroom_agent.application.meeting_writing import MeetingWriter, speech_target

STATE: dict[str, object] = {
    "planningAt": 0,
    "serverNow": 100_000,
    "planVersion": 7,
    "parts": [
        {"partId": "legacy-6", "name": "予算", "startsAt": 60_000, "endsAt": 95_000},
        {"partId": "part-7", "name": "比較", "startsAt": 95_000, "endsAt": 125_000},
        {"partId": "part-3", "name": "振り返り", "startsAt": 125_000, "endsAt": 245_000},
    ],
    "notes": [],
}
TOOL: dict[str, object] = {
    "reason": "合意",
    "operations": [{"action": "rename", "target": "P1", "name": "会場選び"}],
}


def test_finalized_lines_use_speech_time_even_when_recognition_finishes_out_of_order() -> None:
    async def run() -> None:
        now = time.monotonic()
        model, append, propose = AsyncMock(), AsyncMock(), AsyncMock()
        model.summarize_note.side_effect = ["次は施設を比較", "会場費は3万円"]
        model.auto_agenda.return_value = TOOL
        writer = MeetingWriter(model, AsyncMock(return_value=STATE), propose, append)
        for offset, text in [
            (-320, "古い話"),
            (-3, "施設を比較"),
            (-6, "会場費は3万円"),
            (-60, "最初は会場選びにしよう"),
        ]:
            writer.pending.append(Utterance("非公開の話者", now + offset - 1, now + offset, text))
        with patch(
            "classroom_agent.application.meeting_writing.asyncio.sleep", new_callable=AsyncMock
        ):
            await writer.process()
        assert [(c.args[0]["partId"], c.args[0]["text"]) for c in append.await_args_list] == [
            ("part-7", "次は施設を比較"),
            ("legacy-6", "会場費は3万円"),
        ]
        assert "非公開の話者" not in str(model.mock_calls)
        assert "古い話" not in str(model.mock_calls)
        assert json.loads(model.summarize_note.await_args_list[1].args[0])["今回の発言"] == [
            "会場費は3万円"
        ]
        assert propose.await_args is not None
        body = propose.await_args.args[0]
        assert body["source"] == "automatic" and body["basePlanVersion"] == 7
        assert body["operations"][0]["target"] == "legacy-6"
        assert speech_target(STATE, -1) is None and speech_target(STATE, 125_000) is None
        assert speech_target(STATE, 60_000) == "legacy-6"

    asyncio.run(run())


def test_explicit_request_discards_even_a_late_uncancellable_generation() -> None:
    async def run() -> None:
        started = asyncio.Event()

        async def late(_: str) -> dict[str, object]:
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return TOOL
            raise AssertionError

        model, propose = AsyncMock(), AsyncMock()
        model.auto_agenda.side_effect = late
        writer = MeetingWriter(model, AsyncMock(), propose, AsyncMock())
        line = Utterance("人", 1, 2, "順番を変えよう")
        pending = asyncio.create_task(writer.write_agenda([line], STATE, 100))
        await started.wait()
        writer.begin_request()
        await pending
        propose.assert_not_called()
        assert list(writer.pending) == [line]
        writer.last_agenda_request = 3
        writer.direct_finished.set()
        await writer.write_agenda([line, Utterance("人", 3, 4, "依頼", directed=True)], STATE, 100)
        assert model.auto_agenda.await_count == 1

    asyncio.run(run())


def test_explicit_snapshot_waits_for_sent_call_and_retries_identical_unknown_outcome() -> None:
    async def run() -> None:
        started, release = asyncio.Event(), asyncio.Event()
        attempts: list[dict[str, object]] = []

        async def post(body: dict[str, object]) -> str:
            attempts.append(body)
            if len(attempts) == 1:
                started.set()
                await release.wait()
                raise TimeoutError
            return "pending"

        model = AsyncMock()
        model.auto_agenda.return_value = TOOL
        writer = MeetingWriter(model, AsyncMock(), post, AsyncMock())
        background = asyncio.create_task(
            writer.write_agenda([Utterance("人", 1, 2, "会場選び")], STATE, 100)
        )
        await started.wait()
        writer.begin_request()
        reconcile = asyncio.create_task(writer.settle_proposal())
        await asyncio.sleep(0)
        assert not reconcile.done()
        release.set()
        result = await asyncio.gather(background, reconcile, return_exceptions=True)
        assert isinstance(result[0], TimeoutError) and result[1] is None
        assert len(attempts) == 2 and attempts[0] is attempts[1]
        await writer.settle_proposal()
        assert len(attempts) == 2

    asyncio.run(run())


def test_newer_speech_supersedes_generated_plan_without_dropping_the_earlier_condition() -> None:
    async def run() -> None:
        model, propose = AsyncMock(), AsyncMock()
        writer = MeetingWriter(model, AsyncMock(), propose, AsyncMock())
        first = Utterance("人", 1, 2, "会場を決める")
        latest = Utterance("人", 3, 4, "予算は3万円")

        async def additional(_: str) -> dict[str, object]:
            writer.pending.append(latest)
            return TOOL

        model.auto_agenda.side_effect = additional
        await writer.write_agenda([first], STATE, 100)
        propose.assert_not_called()
        assert list(writer.pending) == [first, latest]

        async def continuous(_: str) -> dict[str, object]:
            writer.pending.append(Utterance("別の人", 5, 6, "続けて相談"))
            return TOOL

        model.auto_agenda.side_effect = continuous
        combined = list(writer.pending)
        writer.pending.clear()
        await writer.write_agenda(combined, STATE, 100)
        assert json.loads(model.auto_agenda.await_args.args[0])["今回の発言"] == [
            first.text,
            latest.text,
        ]
        propose.assert_awaited_once()
        assert [line.text for line in writer.pending] == ["続けて相談"]

    asyncio.run(run())


def test_transient_generation_errors_retry_original_speech_once_as_new_input() -> None:
    async def run() -> None:
        now = time.monotonic()
        model, propose, append = AsyncMock(), AsyncMock(), AsyncMock()
        model.summarize_note.side_effect = [ValueError(), "会場を予約"]
        model.auto_agenda.side_effect = [ValueError(), TOOL]
        writer = MeetingWriter(model, AsyncMock(return_value=STATE), propose, append)
        writer.pending.extend(
            [
                Utterance("人", now - 70, now - 65, "最初は場所を決めよう"),
                Utterance("人", now - 3, now - 2, "会場を予約しよう"),
                Utterance("人", now - 2, now - 1, "予約済みだっけ？", directed=True),
            ]
        )
        with patch(
            "classroom_agent.application.meeting_writing.asyncio.sleep", new_callable=AsyncMock
        ):
            with pytest.raises(ValueError):
                await writer.process()
            with pytest.raises(ValueError):
                await writer.process()
            await writer.process()
        for fn, text in [
            (model.auto_agenda, "最初は場所を決めよう"),
            (model.summarize_note, "会場を予約しよう"),
        ]:
            assert fn.await_count == 2
            for call in fn.await_args_list:
                data = json.loads(call.args[0])
                assert data["今回の発言"] == [text] and not data["以前の発言"]
        propose.assert_awaited_once()
        append.assert_awaited_once()

    asyncio.run(run())


def test_idle_reads_are_batched_and_final_reflection_skips_only_new_speech() -> None:
    async def run() -> None:
        now = time.monotonic()
        model, read, append = (
            AsyncMock(),
            AsyncMock(return_value={**STATE, "serverNow": 130_000}),
            AsyncMock(),
        )
        model.summarize_note.return_value = "予算を確認"
        writer = MeetingWriter(model, read, AsyncMock(), append)
        writer.observe_phase({"planningAt": None}, now)
        writer.pending.append(Utterance("人", now - 7, now - 6, "予算を確認する"))
        with patch(
            "classroom_agent.application.meeting_writing.asyncio.sleep", new_callable=AsyncMock
        ) as sleep:
            await writer.process()
            assert sleep.await_args is not None and sleep.await_args.args[0] > 4
            writer.pending.append(Utterance("人", now - 1, now, "振り返り"))
            await writer.process()
            read.assert_awaited_once()
            writer.pending.append(Utterance("人", now - 8, now - 7, "遅れて認識した合意"))
            await writer.process()
            assert read.await_count == 2
            assert "遅れて認識した合意" in model.summarize_note.await_args.args[0]

    asyncio.run(run())


def test_spoken_and_written_prompts_include_the_same_tail_of_long_speech() -> None:
    conversation = Conversation()
    line = Utterance("人", 1, 2, "先頭" + "あ" * HISTORY_CHARS)
    question = Utterance("人", 3, 4, "質問")
    conversation.add(line)
    spoken = json.loads(conversation.prompt([question], STATE, 4).text)
    writer = MeetingWriter(AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock())
    writer.history.append(("part-7", line))
    assert (
        writer.prior_text("part-7", [question])
        == [spoken["直近の会話"][0]["発言"]]
        == ["あ" * HISTORY_CHARS]
    )


def test_question_claimed_during_summarization_is_removed_before_saving() -> None:
    async def run() -> None:
        model, append = AsyncMock(), AsyncMock()
        writer = MeetingWriter(model, AsyncMock(), AsyncMock(), append)
        question = Utterance("人", 1, 2, "予算は確定？")
        statement = Utterance("別の人", 2, 3, "人数を確認する")

        async def overlap(_: str) -> str:
            writer.begin_request()
            question.directed = True
            writer.direct_finished.set()
            return "予算は確定"

        model.summarize_note.side_effect = overlap
        await writer.write_note("part-7", [statement, question], STATE)
        append.assert_not_awaited()
        assert list(writer.pending) == [statement]
        assert not writer.history

    asyncio.run(run())
