"""Listen to admitted member microphones. Only a member RPC starts a spoken reply."""

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, aclosing, suppress
from typing import Protocol
from uuid import NAMESPACE_URL, uuid5

from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, JobRequest

from classroom_agent.application.agenda_proposal import meeting_answer
from classroom_agent.application.meeting_conversation import (
    HISTORY_SECONDS,
    LOOKBACK,
    Conversation,
    Listener,
    Utterance,
    advance_timeline,
)
from classroom_agent.application.meeting_research import MeetingResearch, ResearchWrite
from classroom_agent.application.meeting_writing import MeetingWriter, WritingModel
from classroom_agent.application.voice_probe import (
    INPUT_RATE,
    OUTPUT_RATE,
    ProbeError,
    Providers,
    Speaker,
    speak_text,
)
from classroom_agent.domain.meeting_speech import FRAME_MS
from classroom_agent.infrastructure.meeting_context import ContextDenied, ContextUnavailable
from classroom_agent.infrastructure.voice_room import RoomOutput

AGENT_NAME = "ainote-meeting"
TOPIC = "ainote.meeting.voice.v1"
MEMBERS = ("ノト", "ピコ", "ロロ")
MEMBER_ID = re.compile(r"member-[a-f0-9]{64}-[1-9][0-9]*")
ROOM_NAME = re.compile(
    r"meeting-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
)


async def accept_meeting(request: JobRequest) -> None:
    if ROOM_NAME.fullmatch(request.room.name) and request.job.metadata in MEMBERS:
        await request.accept(name=request.job.metadata, identity=AGENT_NAME)
    else:
        await request.reject()


class MeetingProviders(Providers, WritingModel, Protocol):
    async def lookup_research(self, query: dict[str, object]) -> dict[str, str] | None: ...

    async def propose_or_answer(self, prompt: str) -> str | dict[str, object]: ...


class ContextReader(Protocol):
    async def research(self, body: dict[str, object]) -> dict[str, str]: ...
    async def append_note(self, note: dict[str, object]) -> str: ...
    async def submit(self, proposal: dict[str, object]) -> str: ...
    async def read(self) -> dict[str, object]: ...
    async def aclose(self) -> None: ...


class MeetingTurns(RoomOutput):
    def __init__(
        self,
        room: rtc.Room,
        source: rtc.AudioSource,
        providers: MeetingProviders,
        read_context: Callable[[], Awaitable[dict[str, object]]],
        submit_proposal: Callable[[dict[str, object]], Awaitable[str]],
        append_note: Callable[[dict[str, object]], Awaitable[str]],
        research_write: ResearchWrite | None = None,
    ) -> None:
        super().__init__(room.local_participant, source, topic=TOPIC, destinations=())
        self.room = room
        self.providers = providers
        self.read_context = read_context
        self.submit_proposal = submit_proposal
        self.accepting = False
        self.recheck = asyncio.Event()
        self.append_note = append_note

        async def publish_research(body: dict[str, object]) -> dict[str, str]:
            assert research_write is not None
            receipt = await research_write(body)
            # Only the revision hint travels via RTC. Each browser rechecks its membership with Web.
            with suppress(Exception):
                async with asyncio.timeout(0.5):
                    await self.send({"type": "research_changed"})
            return receipt

        self.research = (
            MeetingResearch(publish_research, providers.lookup_research) if research_write else None
        )
        self.departed_names: dict[str, float] = {}
        self.writer = MeetingWriter(providers, read_context, submit_proposal, self.save_note)
        self.writing: asyncio.Task[None] | None = None
        self.conversation = Conversation(self.finalized)
        self.listeners: dict[str, Listener] = {}
        self.readers: dict[str, tuple[rtc.Track, asyncio.Task[None]]] = {}
        self.mic_available = asyncio.Event()
        self.closing: set[asyncio.Task[None]] = set()
        self.started = 0.0
        self.last_finish = float("-inf")
        self.owner = ""
        self.turn_id = ""
        self.task: asyncio.Task[None] | None = None
        self.finished = asyncio.Event()
        self.phase = "ready"
        self.state_lock = asyncio.Lock()

    async def state(self, phase: str) -> None:
        self.phase = phase
        await self.publish_state()

    async def publish_state(self) -> None:
        async with self.state_lock:
            await self.participant.set_attributes(
                {
                    "ainote.phase": self.phase if self.accepting else "connecting",
                    "ainote.owner": self.owner if self.accepting else "",
                    "ainote.turn": self.turn_id if self.accepting else "",
                }
            )

    def expire_names(self, now: float) -> None:
        self.departed_names = {
            name: until for name, until in self.departed_names.items() if until > now
        }

    async def save_note(self, note: dict[str, object]) -> str:
        # Keep known display names out of shared notes even if the model quotes a speaker.
        text = str(note["text"])
        now = time.monotonic()
        self.expire_names(now)
        names = self.departed_names.keys() | {
            member.name
            for member in self.room.remote_participants.values()
            if member.name and MEMBER_ID.fullmatch(member.identity)
        }
        for name in sorted(names, key=len, reverse=True):
            if len(name) > 2:
                text = text.replace(name, "参加者")
            else:
                # Short names are also ordinary word fragments (会場, AI活用).
                # Match an independent name or one marked by an honorific or particle.
                escaped = re.escape(name)
                text = re.sub(
                    rf"{escaped}(?=さん|氏|君|様)|(?<!\w){escaped}(?=$|\W|[がはをにへも])",
                    "＊",  # Redaction must not push a valid note over 180 UTF-16 units.
                    text,
                )
        if len(text.encode("utf-16-le")) > 360:
            return "invalid-note"
        return await self.append_note({**note, "text": text})

    async def submit_requested(self, proposal: dict[str, object]) -> str:
        self.writer.last_agenda_request = self.started
        return await self.submit_proposal(proposal)

    def finalized(self, line: Utterance) -> None:
        if not self.accepting:
            return
        self.writer.pending.append(line)
        if self.writing is None or self.writing.done():
            self.writing = asyncio.create_task(self.write_background())

    async def write_background(self) -> None:
        delay = 1
        while self.writer.pending and self.accepting:
            try:
                await self.writer.process()
            except ContextDenied:
                self.pause()
            except Exception:
                # Preserve unsummarized speech within its history window during an outage.
                await asyncio.sleep(delay)
                delay = min(delay * 2, 15)

    def stop_writing(self) -> None:
        if self.writing and self.writing is not asyncio.current_task():
            self.retire_reader(self.writing)
        self.writing = None
        self.writer.clear()

    def pause(self) -> None:
        self.stop_writing()
        self.accepting = False
        for identity, (_, task) in self.readers.items():
            task.cancel()
            self.listeners[identity].cut_audio()
        self.recheck.set()

    async def caption(self, speaker: Speaker, text: str) -> None:
        if speaker == "ai":
            await self.state("speaking")
        await self.send({"type": "caption", "speaker": speaker, "owner": self.owner, "text": text})
        if speaker == "ai":
            now = time.monotonic()
            self.conversation.add(Utterance("AI", now, now, text))

    def published(
        self, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant
    ) -> None:
        if (
            self.accepting
            and MEMBER_ID.fullmatch(participant.identity)
            and publication.source == rtc.TrackSource.SOURCE_MICROPHONE
        ):
            publication.set_subscribed(True)

    def subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        identity = participant.identity
        if (
            not self.accepting
            or not MEMBER_ID.fullmatch(identity)
            or publication.source != rtc.TrackSource.SOURCE_MICROPHONE
        ):
            return
        old = self.readers.get(identity)
        if old and old[0].sid == track.sid:
            if old[0] is track and not old[1].done() and not old[1].cancelling():
                return
            self.retire_reader(old[1])
            listener = self.listeners[identity]
            listener.cut_audio()
        else:
            self.stop_mic(identity)
            listener = Listener(identity, self.conversation, self.providers.transcribe)
            self.listeners[identity] = listener
            self.mic_available.set()
        task = asyncio.create_task(self.read_mic(track, listener))
        self.readers[identity] = (track, task)

    async def read_mic(self, track: rtc.Track, listener: Listener) -> None:
        delay = 0.25
        while True:
            try:
                async with aclosing(
                    rtc.AudioStream(
                        track, sample_rate=INPUT_RATE, num_channels=1, frame_size_ms=FRAME_MS
                    )
                ) as stream:
                    async for event in stream:
                        if self.accepting:
                            listener.feed(event.frame.data.tobytes(), time.monotonic())
                            delay = 0.25
            except Exception:
                # An RTC stream can end while the same microphone is still published.
                pass
            listener.cut_audio()
            await asyncio.sleep(delay)
            delay = min(2 * delay, 4)
            member = self.room.remote_participants.get(listener.speaker)
            publication = member.track_publications.get(track.sid) if member else None
            if not self.accepting or publication is None or publication.track is not track:
                return

    def unsubscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        reader = self.readers.get(participant.identity)
        if not self.accepting or not reader or reader[0] is not track:
            return
        if participant.track_publications.get(track.sid) is publication:
            self.retire_reader(reader[1])
            self.listeners[participant.identity].cut_audio()
            self.published(publication, participant)
        else:
            self.stop_mic(participant.identity)

    def unpublished(
        self, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant
    ) -> None:
        reader = self.readers.get(participant.identity)
        if self.accepting and reader and reader[0].sid == publication.sid:
            self.stop_mic(participant.identity)

    def retire_reader(self, task: asyncio.Task[None]) -> None:
        task.cancel()
        self.closing.add(task)
        task.add_done_callback(self.closing.discard)

    def stop_mic(self, identity: str) -> None:
        reader = self.readers.pop(identity, None)
        if reader:
            self.retire_reader(reader[1])
        listener = self.listeners.pop(identity, None)
        if listener:
            close = asyncio.create_task(listener.close())
            self.closing.add(close)
            close.add_done_callback(self.closing.discard)
            if self.task and self.owner == identity:
                self.task.cancel()

    async def close(self) -> None:
        self.accepting = False
        self.stop_writing()
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.research:
            await self.research.close()
        for identity in list(self.readers):
            self.stop_mic(identity)
        await asyncio.gather(*self.closing, return_exceptions=True)
        self.conversation.lines.clear()

    def muted(
        self, participant: rtc.RemoteParticipant, publication: rtc.RemoteTrackPublication
    ) -> None:
        reader = self.readers.get(participant.identity)
        if reader and reader[0].sid == publication.sid:
            self.listeners[participant.identity].flush()

    def sync_mics(self) -> None:
        active = set()
        for member in self.room.remote_participants.values():
            for pub in member.track_publications.values():
                self.published(pub, member)
                if pub.source == rtc.TrackSource.SOURCE_MICROPHONE:
                    active.add(member.identity)
                    if pub.track:
                        self.subscribed(pub.track, pub, member)
        for identity in self.readers.keys() - active:
            self.stop_mic(identity)

    async def command(self, data: rtc.RpcInvocationData) -> str:
        caller = self.room.remote_participants.get(data.caller_identity)
        if caller is None or not MEMBER_ID.fullmatch(caller.identity):
            return "unavailable"
        present = re.fullmatch(r"present:([a-f0-9-]{36})", data.payload)
        if data.payload == "start" or (present and self.research):
            if not self.accepting:
                return "unavailable"
            if self.task is not None:
                return "busy"
            # Reserve the speaker before yielding so concurrent requests cannot both win.
            self.owner = "" if present else caller.identity
            self.turn_id = data.request_id
            self.finished = asyncio.Event()
            self.started = time.monotonic()
            self.writer.begin_request()
            self.task = asyncio.create_task(
                self.present(present[1]) if present else self.answer(caller)
            )
            self.task.add_done_callback(self.released)
            return "ok"
        if self.task and caller.identity == self.owner and data.payload == "finish:" + self.turn_id:
            self.finished.set()
            return "ok"
        return "unavailable"

    async def present(self, research_id: str) -> None:
        assert self.research is not None
        claim = {
            "id": research_id,
            "grant": str(uuid5(NAMESPACE_URL, "ainote/grants/" + self.turn_id)),
        }
        release = False
        try:
            async with asyncio.timeout(40):
                await self.state("thinking")
                release = True
                receipt = await self.research.write({**claim, "action": "present"})
                if receipt["status"] != "present":
                    release = False
                    await self.send({"type": "error", "stage": "research_unavailable"})
                    return
                if self.accepting:
                    await speak_text(self.providers, self, receipt["speech"])
                    release = False
                    await self.research.write({**claim, "action": "spoken"})
        except ContextDenied:
            self.pause()
            await self.send({"type": "error", "stage": "connection"})
        except (ProbeError, TimeoutError) as exc:
            await self.send(
                {"type": "error", "stage": exc.stage if isinstance(exc, ProbeError) else "timeout"}
            )
        except Exception:
            await self.send({"type": "error", "stage": "connection"})
        finally:
            if release:
                # Also releases an accepted claim whose response was lost. Web checks the grant.
                with suppress(Exception):
                    await self.research.write({**claim, "action": "release"})
            self.source.clear_queue()
            self.owner = self.turn_id = ""
            if self.room.isconnected():
                await self.state("ready")

    def left(self, participant: rtc.RemoteParticipant) -> None:
        if not self.accepting:
            return  # Reconcile the confirmed participant list after reconnect.
        if participant.name and MEMBER_ID.fullmatch(participant.identity):
            now = time.monotonic()
            self.expire_names(now)
            self.departed_names[participant.name] = now + HISTORY_SECONDS
        self.stop_mic(participant.identity)
        if self.task and participant.identity == self.owner:
            self.task.cancel()

    def released(self, task: asyncio.Task[None]) -> None:
        # Departure may cancel the task before answer() enters its try/finally.
        if self.task is task:
            self.writer.direct_finished.set()
            self.last_finish = time.monotonic()
            self.owner = self.turn_id = ""
            self.task = None
        if not task.cancelled():
            # RTC can disconnect during the final state notification.
            task.exception()

    async def snapshot(self) -> tuple[dict[str, object], float]:
        # One identical replay is enough; a failing POST must not block a healthy read.
        with suppress(ContextUnavailable):
            await self.writer.settle_proposal()
        value = await self.read_context()
        return value, time.monotonic()

    async def reply_context(
        self, initial: asyncio.Task[tuple[dict[str, object], float]], question: str
    ) -> dict[str, object]:
        # The button starts a read during recording. Recheck a completed snapshot
        # for edits made while the member was speaking. If the recheck fails,
        # the first read still supports a qualified answer, but not a proposal.
        prefetched = initial.done()
        try:
            state, received = await initial
        except ContextUnavailable:
            try:
                state, received = await self.snapshot()
            except ContextUnavailable:
                return {"availability": "進行状況は未確認"}
            return advance_timeline(state, time.monotonic() - received)
        boundary, server_now = state.get("nextBoundary"), state.get("serverNow")
        elapsed = time.monotonic() - received
        crossed = (
            isinstance(boundary, int)
            and isinstance(server_now, int)
            and server_now + elapsed * 1000 >= boundary
        )
        if (
            prefetched
            or crossed
            or re.search(r"予定|残り|あと何分|進行|パート|メモ|最新|スケジュール", question)
        ):
            try:
                state, received = await self.snapshot()
            except ContextUnavailable:
                state = {
                    **state,
                    "availability": "再取得できなかったため、直前に確認した予定から計算",
                }
        return advance_timeline(state, time.monotonic() - received)

    async def answer(self, caller: rtc.RemoteParticipant) -> None:
        snapshot = asyncio.create_task(self.snapshot())
        try:
            async with asyncio.timeout(150):
                await self.state("listening")
                async with asyncio.timeout(10):
                    while (listener := self.listeners.get(caller.identity)) is None:
                        self.mic_available.clear()
                        await self.mic_available.wait()
                asked = await listener.question(
                    max(self.last_finish, self.started - LOOKBACK), self.finished
                )
                for line in asked:
                    line.directed = True
                question = "".join(item.text or "" for item in asked)
                await self.state("thinking")
                await self.caption("user", question)
                background = asyncio.create_task(
                    self.conversation.wait_for_background(asked[-1].end)
                )
                try:
                    state = await self.reply_context(snapshot, question)
                    await background
                finally:
                    background.cancel()
                    await asyncio.gather(background, return_exceptions=True)
                prompt = self.conversation.prompt(asked, state, time.monotonic())
                reply = await meeting_answer(
                    prompt,
                    self.turn_id,
                    self.providers.propose_or_answer,
                    self.submit_requested,
                    self.research.start if self.research else None,
                )
                self.writer.direct_finished.set()
                if reply:
                    await speak_text(self.providers, self, reply)
        except ContextDenied:
            self.pause()
            await self.send({"type": "error", "stage": "connection"})
        except (ProbeError, TimeoutError) as exc:
            await self.send(
                {"type": "error", "stage": exc.stage if isinstance(exc, ProbeError) else "timeout"}
            )
        except Exception:
            await self.send({"type": "error", "stage": "connection"})
        finally:
            snapshot.cancel()
            await asyncio.gather(snapshot, return_exceptions=True)
            self.source.clear_queue()
            self.owner = self.turn_id = ""
            if self.room.isconnected():
                await self.state("ready")


async def monitor_room(turns: MeetingTurns) -> None:
    room = turns.room
    online = room.isconnected()
    ended = not online

    def reconnecting() -> None:
        nonlocal online
        online = False
        turns.pause()

    def reconnected() -> None:
        nonlocal online
        online = True
        turns.pause()

    def disconnected() -> None:
        nonlocal ended
        ended = True
        reconnecting()

    async def admit() -> None:
        delay = 1
        await turns.publish_state()
        while True:
            try:
                state = await turns.read_context()
            except ContextDenied as exc:
                if exc.status == 410:
                    disconnected()
                    return
            except ContextUnavailable:
                pass
            else:
                if not turns.recheck.is_set():
                    turns.writer.observe_phase(state, time.monotonic())
                    turns.accepting = True
                    turns.sync_mics()
                    await turns.publish_state()
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15)

    room.on("reconnecting", reconnecting)
    room.on("reconnected", reconnected)
    room.on("disconnected", disconnected)
    try:
        async with asyncio.TaskGroup() as group:
            while not ended:
                turns.recheck.clear()
                check = group.create_task(admit()) if online else None
                try:
                    await turns.recheck.wait()
                finally:
                    if check:
                        check.cancel()
    finally:
        turns.accepting = False
        room.off("reconnecting", reconnecting)
        room.off("reconnected", reconnected)
        room.off("disconnected", disconnected)


async def run_meeting_room(
    ctx: JobContext,
    open_providers: Callable[[AsyncExitStack, str], MeetingProviders],
    open_context: Callable[[str], ContextReader],
) -> None:
    ctx.init_recording({"audio": False, "transcript": False, "logs": False, "traces": False})
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    async with AsyncExitStack() as stack:
        source = await stack.enter_async_context(aclosing(rtc.AudioSource(OUTPUT_RATE, 1)))
        context = await stack.enter_async_context(
            aclosing(open_context(ctx.room.name.removeprefix("meeting-")))
        )
        turns = MeetingTurns(
            ctx.room,
            source,
            open_providers(stack, ctx.job.metadata),
            context.read,
            context.submit,
            context.append_note,
            context.research,
        )
        track = rtc.LocalAudioTrack.create_audio_track("AI", source)
        ctx.room.on("track_published", turns.published)
        ctx.room.on("track_subscribed", turns.subscribed)
        ctx.room.on("track_unsubscribed", turns.unsubscribed)
        ctx.room.on("track_unpublished", turns.unpublished)
        ctx.room.on("track_muted", turns.muted)
        ctx.room.on("participant_disconnected", turns.left)
        try:
            await ctx.room.local_participant.publish_track(
                track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
            )
            ctx.room.local_participant.register_rpc_method(TOPIC, turns.command)
            await monitor_room(turns)
        finally:
            ctx.room.off("participant_disconnected", turns.left)
            ctx.room.off("track_unpublished", turns.unpublished)
            ctx.room.off("track_muted", turns.muted)
            ctx.room.off("track_published", turns.published)
            ctx.room.off("track_subscribed", turns.subscribed)
            ctx.room.off("track_unsubscribed", turns.unsubscribed)
            await turns.close()
            ctx.shutdown("meeting finished")
