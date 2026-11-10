import asyncio
import time
from collections.abc import Callable
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from livekit import rtc
from livekit.agents import JobRequest

from classroom_agent.application.meeting_conversation import Utterance
from classroom_agent.application.voice_probe import ProbeError
from classroom_agent.infrastructure import meeting_voice as meeting
from classroom_agent.infrastructure.meeting_context import ContextDenied, ContextUnavailable

HOST = "member-" + "a" * 64 + "-1"
GUEST = "member-" + "b" * 64 + "-1"


def test_dispatch_requires_a_server_created_room_and_preset() -> None:
    request = AsyncMock(spec=JobRequest)
    request.room.name = "voice-probe-2495a326-91fe-4a3d-931e-4593f77fabd2"
    request.job.metadata = "ノト"
    asyncio.run(meeting.accept_meeting(request))
    request.reject.assert_awaited_once()
    request.room.name = "meeting-2495a326-91fe-4a3d-931e-4593f77fabd2"
    request.job.metadata = "ピコ"
    asyncio.run(meeting.accept_meeting(request))
    request.accept.assert_awaited_once_with(name="ピコ", identity="ainote-meeting")


def test_only_the_rpc_sender_can_finish_and_leaving_releases_the_turn() -> None:
    async def run() -> None:
        room = MagicMock()
        a, b = MagicMock(identity=HOST), MagicMock(identity=GUEST)
        room.remote_participants = {HOST: a, GUEST: b}
        turns = meeting.MeetingTurns(
            room, MagicMock(), MagicMock(), AsyncMock(return_value={}), AsyncMock(), AsyncMock()
        )
        turns.accepting = True

        def command(sender: str, payload: str, rid: str = "first") -> rtc.RpcInvocationData:
            return rtc.RpcInvocationData(rid, sender, payload, 4.0)

        async def hold(_: rtc.RemoteParticipant) -> None:
            await asyncio.Event().wait()

        with patch.object(turns, "answer", side_effect=hold):
            assert await turns.command(command("unknown", "start")) == "unavailable"
            assert await turns.command(command(HOST, "start")) == "ok"
            assert await turns.command(command(GUEST, "start")) == "busy"
            assert await turns.command(command(GUEST, "finish:first")) == "unavailable"
            assert await turns.command(command(HOST, "finish:old")) == "unavailable"
            assert not turns.finished.is_set()
            assert await turns.command(command(HOST, "finish:first")) == "ok"
            assert turns.finished.is_set()
            turns.left(b)
            assert turns.task and not turns.task.cancelling()
            turns.left(a)  # including departure before the capture coroutine starts
            await asyncio.gather(turns.task, return_exceptions=True)
            assert await turns.command(command(GUEST, "start", "second")) == "ok"
            turns.left(b)
            assert turns.task
            await asyncio.gather(turns.task, return_exceptions=True)

    asyncio.run(run())


@pytest.mark.parametrize("failure", ["", "tts", "context"])
def test_turn_uses_the_shared_transcript_and_releases_after_errors(failure: str) -> None:
    async def run() -> None:
        room, source = MagicMock(), MagicMock()
        room.local_participant.set_attributes = AsyncMock()
        room.local_participant.publish_data = AsyncMock()
        context = AsyncMock(return_value={"topic": "お題"})
        generate = AsyncMock(return_value="3万円です")
        turns = meeting.MeetingTurns(
            room, source, MagicMock(propose_or_answer=generate), context, AsyncMock(), AsyncMock()
        )
        turns.accepting = True
        turns.owner = GUEST
        turns.started = time.monotonic()
        a = Utterance(HOST, 1, turns.started, "会場費は3万円")
        b = Utterance(GUEST, 2, turns.started, "予定の予算は？")
        turns.conversation.add(a)
        turns.conversation.add(b)
        listener = MagicMock()
        listener.question = AsyncMock(return_value=[b])
        turns.listeners[GUEST] = listener
        with patch.object(meeting, "speak_text", new_callable=AsyncMock) as reply:

            async def speak(*_: object) -> None:
                await turns.caption("ai", "3万円です")
                if failure == "tts":
                    raise ProbeError("tts")

            reply.side_effect = speak
            if failure == "context":
                context.side_effect = RuntimeError("private")
            await turns.answer(MagicMock(identity=GUEST))
            if not failure:
                assert generate.await_args is not None
                prompt = generate.await_args.args[0]
                assert all(
                    prompt.count(s) == 1 for s in ("会場費は3万円", "予定の予算は？", "お題")
                )
                assert turns.conversation.lines[-1].speaker == "AI"
                assert context.await_count == 2
            if failure == "tts":
                assert turns.conversation.lines[-1].text == "3万円です"
            assert "private" not in str(room.local_participant.publish_data.call_args)
            assert turns.owner == ""
            source.clear_queue.assert_called_once()

    asyncio.run(run())


def test_replacement_track_and_delayed_unsubscribe_do_not_drop_the_new_mic() -> None:
    async def run() -> None:
        room = MagicMock()
        turns = meeting.MeetingTurns(
            room, MagicMock(), MagicMock(), AsyncMock(return_value={}), AsyncMock(), AsyncMock()
        )
        turns.accepting = True
        pub = MagicMock(source=rtc.TrackSource.SOURCE_MICROPHONE)
        guest = MagicMock(identity=GUEST)
        ai = MagicMock(identity=meeting.AGENT_NAME)
        camera = MagicMock(source=rtc.TrackSource.SOURCE_CAMERA)
        first, second = MagicMock(sid="one"), MagicMock(sid="two")
        turns.published(pub, ai)
        turns.published(camera, guest)
        pub.set_subscribed.assert_not_called()
        turns.published(pub, guest)
        pub.set_subscribed.assert_called_once_with(True)
        turns.subscribed(first, pub, ai)
        turns.subscribed(first, camera, guest)
        assert not turns.readers
        with patch.object(turns, "read_mic", new_callable=AsyncMock):
            turns.subscribed(first, pub, guest)
            old = turns.listeners[GUEST]
            turns.subscribed(first, pub, guest)
            assert turns.listeners[GUEST] is old
            turns.subscribed(second, pub, guest)
            turns.unsubscribed(first, pub, guest)
            assert turns.listeners[GUEST] is not old
            turns.unsubscribed(second, pub, guest)
            assert not turns.readers and not turns.listeners
            await turns.close()
            assert old.worker.done()

    asyncio.run(run())


@pytest.mark.parametrize("stop", ["leave", "unsubscribe", "reconnect"])
def test_stopping_a_speaking_mic_settles_every_utterance(stop: str) -> None:
    async def run() -> None:
        room = MagicMock()
        room.remote_participants = {}
        turns = meeting.MeetingTurns(
            room, MagicMock(), MagicMock(), AsyncMock(return_value={}), AsyncMock(), AsyncMock()
        )
        turns.accepting = True
        guest = MagicMock(identity=GUEST)
        pub = MagicMock(source=rtc.TrackSource.SOURCE_MICROPHONE)
        track = MagicMock(sid="mic")
        read = asyncio.Event()
        closing = asyncio.Event()
        release = asyncio.Event()

        class Stream:
            def __aiter__(self) -> "Stream":
                return self

            async def __anext__(self) -> rtc.AudioFrameEvent:
                if read.is_set():
                    await asyncio.Event().wait()
                read.set()
                pcm = (3000).to_bytes(2, "little") * 320
                return rtc.AudioFrameEvent(rtc.AudioFrame(pcm, 16000, 1, 320))

            async def aclose(self) -> None:
                closing.set()
                await release.wait()

        with patch.object(rtc, "AudioStream", return_value=Stream()):
            turns.subscribed(track, pub, guest)
            await asyncio.wait_for(read.wait(), 1)
            if stop == "leave":
                turns.left(guest)
            elif stop == "unsubscribe":
                turns.unsubscribed(track, pub, guest)
            else:
                turns.sync_mics()
            await asyncio.wait_for(closing.wait(), 1)
            await asyncio.sleep(0)
            release.set()
            await asyncio.wait_for(asyncio.gather(*turns.closing, return_exceptions=True), 1)
            assert all(line.failed or line.text is not None for line in turns.conversation.lines)
            await turns.close()

    asyncio.run(run())


def test_monitor_survives_a_cold_start_and_revalidates_identical_tracks_on_reconnect() -> None:
    async def run() -> None:
        room = MagicMock()
        callbacks: dict[str, Callable[[], None]] = {}
        room.on.side_effect = lambda event, callback: callbacks.update({event: callback})
        room.local_participant.set_attributes = AsyncMock()
        guest = MagicMock(identity=GUEST)
        pub = MagicMock(source=rtc.TrackSource.SOURCE_MICROPHONE)
        pub.track.sid = "same"
        guest.track_publications = {"same": pub}
        room.remote_participants = {GUEST: guest}
        api = AsyncMock(
            side_effect=[ContextDenied(404), {}, ContextDenied(403), {}, ContextDenied(410)]
        )
        turns = meeting.MeetingTurns(room, MagicMock(), MagicMock(), api, AsyncMock(), AsyncMock())
        with patch.object(turns, "read_mic", new_callable=AsyncMock):
            task = asyncio.create_task(meeting.monitor_room(turns))

            async def wait_ready() -> None:
                async with asyncio.timeout(2):
                    while not turns.accepting:
                        await asyncio.sleep(0.01)

            await asyncio.sleep(0.02)
            assert not turns.accepting and not turns.listeners
            await wait_ready()
            original = turns.listeners[GUEST]
            old_reader = turns.readers[GUEST][1]
            owner = asyncio.create_task(asyncio.sleep(60))
            turns.task = owner
            turns.owner = GUEST
            await turns.state("thinking")
            track = pub.track
            pub.track = None  # Subscription is restored after the context check.
            callbacks["reconnecting"]()
            callbacks["reconnected"]()
            await asyncio.sleep(0.02)
            assert not turns.accepting and not owner.done()
            attributes = room.local_participant.set_attributes.await_args.args[0]
            assert attributes == {
                "ainote.phase": "connecting",
                "ainote.owner": "",
                "ainote.turn": "",
            }
            await wait_ready()
            assert (
                room.local_participant.set_attributes.await_args.args[0]["ainote.phase"]
                == "thinking"
            )
            pub.track = MagicMock(sid=track.sid)
            turns.subscribed(pub.track, pub, guest)
            turns.unsubscribed(track, pub, guest)  # Stale delivery for the same SID.

            assert turns.listeners[GUEST] is original and not owner.done()
            assert turns.readers[GUEST][1] is not old_reader
            callbacks["reconnected"]()
            await asyncio.wait_for(task, 1)
            assert not turns.accepting
            await turns.close()

    asyncio.run(run())


def test_failed_refresh_uses_elapsed_server_time_and_never_reuses_a_denied_snapshot() -> None:
    async def run() -> None:
        api = AsyncMock(side_effect=[ContextUnavailable(), ContextDenied(403)])
        turns = meeting.MeetingTurns(
            MagicMock(), MagicMock(), MagicMock(), api, AsyncMock(), AsyncMock()
        )
        state = {
            "serverNow": 1000,
            "nextBoundary": 3000,
            "parts": [
                {"partId": "A", "startsAt": 0, "endsAt": 3000},
                {"partId": "B", "startsAt": 3000, "endsAt": 65000},
            ],
        }
        initial = asyncio.create_task(asyncio.sleep(0, result=(state, time.monotonic() - 4)))
        refreshed = await turns.reply_context(initial, "あと何分？")
        assert refreshed["remainingSeconds"] == 60 and refreshed["currentPartId"] == "B"
        assert refreshed["nextBoundary"] == 65000
        assert "availability" in refreshed
        with pytest.raises(ContextDenied):
            await turns.reply_context(initial, "あと何分？")
        api.side_effect = [ContextUnavailable(), state]
        recovered = await turns.reply_context(asyncio.create_task(turns.snapshot()), "残り時間は？")
        assert recovered["currentPartId"] == "A"
        missing = asyncio.create_task(turns.snapshot())
        api.side_effect = ContextUnavailable()
        assert await turns.reply_context(missing, "会場は？") == {
            "availability": "進行状況は未確認"
        }

    asyncio.run(run())


def test_mute_event_and_pause_cut_audio_at_each_boundary() -> None:
    async def run() -> None:
        providers = MagicMock(transcribe=AsyncMock(return_value="合成"))
        turns = meeting.MeetingTurns(
            MagicMock(), MagicMock(), providers, AsyncMock(), AsyncMock(), AsyncMock()
        )
        turns.accepting = True
        emitter: rtc.EventEmitter[str] = rtc.EventEmitter()
        emitter.on("track_muted", turns.muted)
        track = MagicMock(sid="mic")
        participant = MagicMock(identity=GUEST)
        publication = MagicMock(sid="mic", source=rtc.TrackSource.SOURCE_MICROPHONE)
        pcm = (3000).to_bytes(2, "little") * 320
        with patch.object(turns, "read_mic", new_callable=AsyncMock):
            turns.subscribed(track, publication, participant)
            listener = turns.listeners[GUEST]
            listener.feed(pcm, 1)
            emitter.emit("track_muted", participant, publication)
            assert len(turns.conversation.lines) == 1
            listener.feed(pcm, 2)
            turns.pause()
            turns.accepting = True
            listener.feed(pcm, 10)
            listener.flush()
            await asyncio.wait_for(listener.queue.join(), 1)
            assert [c.args[0] for c in providers.transcribe.await_args_list] == [
                pcm,
                pcm,
                pcm,
            ]
            await turns.close()

    asyncio.run(run())


def test_published_track_with_an_ended_stream_opens_a_new_reader() -> None:
    async def run() -> None:
        track = MagicMock(sid="mic")
        pub = MagicMock(track=track, source=rtc.TrackSource.SOURCE_MICROPHONE)
        member = MagicMock(identity=GUEST, track_publications={"mic": pub})
        room = MagicMock(remote_participants={GUEST: member})
        turns = meeting.MeetingTurns(
            room, MagicMock(), MagicMock(), AsyncMock(), AsyncMock(), AsyncMock()
        )
        turns.accepting = True
        reopened = asyncio.Event()

        class Stream:
            def __aiter__(self) -> "Stream":
                return self

            async def __anext__(self) -> rtc.AudioFrameEvent:
                if factory.call_count == 1:
                    raise StopAsyncIteration
                reopened.set()
                await asyncio.Event().wait()
                raise AssertionError

            async def aclose(self) -> None:
                pass

        with patch.object(rtc, "AudioStream", side_effect=lambda *a, **kw: Stream()) as factory:
            turns.subscribed(track, pub, member)
            await asyncio.wait_for(reopened.wait(), 2)
            assert factory.call_count == 2
            await turns.close()

    asyncio.run(run())


def test_shared_note_omits_known_display_names_even_when_the_model_returns_them() -> None:
    async def run() -> None:
        save = AsyncMock(return_value="saved")
        room = MagicMock()
        turns = meeting.MeetingTurns(room, MagicMock(), MagicMock(), AsyncMock(), AsyncMock(), save)
        member = MagicMock(identity="member-" + "a" * 64 + "-1")
        member.name = "合成太郎"
        room.remote_participants = {member.identity: member}
        assert await turns.save_note({"id": "note", "text": "合成太郎が費用を確認する"}) == "saved"
        save.assert_awaited_once_with({"id": "note", "text": "参加者が費用を確認する"})
        member.name = "会"
        await turns.save_note({"text": "会場費は3万円。会さんが確認"})
        save.assert_awaited_with({"text": "会場費は3万円。＊さんが確認"})
        turns.accepting = True
        turns.left(member)
        room.remote_participants.clear()
        assert "会" in turns.departed_names
        turns.departed_names["会"] = time.monotonic() - 1
        await turns.save_note({"text": "会場を予約"})
        assert not turns.departed_names
        assert await turns.save_note({"text": "😀" * 91}) == "invalid-note"

    asyncio.run(run())


def test_explicit_snapshot_reads_plan_even_when_automatic_replay_is_unavailable() -> None:
    async def run() -> None:
        read = AsyncMock(return_value={"planVersion": 3})
        post = AsyncMock(side_effect=ContextUnavailable())
        turns = meeting.MeetingTurns(MagicMock(), MagicMock(), MagicMock(), read, post, AsyncMock())
        turns.writer.unconfirmed = {"id": "same-call"}
        for _ in range(2):
            state, _ = await turns.snapshot()
            assert state == {"planVersion": 3}
        post.assert_awaited_once_with({"id": "same-call"})

    asyncio.run(run())


@pytest.mark.parametrize("outcome", ["spoken", "tts", "unavailable"])
def test_research_presentation_belongs_to_room_and_unlocks_after_failure(outcome: str) -> None:
    async def run() -> None:
        room = MagicMock()
        host = MagicMock(identity=HOST)
        host.name = "主催者"
        room.remote_participants = {HOST: host, GUEST: MagicMock(identity=GUEST)}
        write = AsyncMock(
            return_value={
                "status": "unavailable" if outcome == "unavailable" else "present",
                "speech": "調査結果",
            }
        )
        turns = meeting.MeetingTurns(
            room, MagicMock(), MagicMock(), AsyncMock(), AsyncMock(), AsyncMock(), write
        )
        turns.accepting = True
        payload = "present:2495a326-91fe-4a3d-931e-4593f77fabd2"
        with (
            patch.object(turns, "state", new_callable=AsyncMock) as state,
            patch.object(turns, "send", new_callable=AsyncMock) as send,
            patch.object(meeting, "speak_text", new_callable=AsyncMock) as speak,
        ):
            if outcome == "tts":
                speak.side_effect = ProbeError("tts")
            assert await turns.command(rtc.RpcInvocationData("one", HOST, payload, 4)) == "ok"
            assert await turns.command(rtc.RpcInvocationData("two", GUEST, payload, 4)) == "busy"
            turns.left(host)
            assert turns.task
            await turns.task
            state.assert_awaited_with("ready")
            actions = [c.args[0]["action"] for c in write.await_args_list]
            if outcome == "unavailable":
                speak.assert_not_awaited()
                assert actions == ["present"]
                send.assert_any_await({"type": "error", "stage": "research_unavailable"})
            else:
                assert actions == ["present", "release" if outcome == "tts" else "spoken"]
                assert (
                    write.await_args_list[0].args[0]["grant"]
                    == write.await_args_list[1].args[0]["grant"]
                )
                speak.assert_awaited_once()
                if outcome == "tts":
                    send.assert_any_await({"type": "error", "stage": "tts"})

    asyncio.run(run())
