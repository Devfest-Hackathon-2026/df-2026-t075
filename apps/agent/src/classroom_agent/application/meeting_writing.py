"""Turn finalized human speech into silent, room-scoped agenda and note writes."""

import asyncio
import json
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable
from typing import Protocol
from uuid import uuid4

from classroom_agent.application.agenda_proposal import proposal_body
from classroom_agent.application.meeting_conversation import (
    HISTORY_SECONDS,
    MeetingPrompt,
    Utterance,
    labeled_plan,
    recent_speech,
)


class WritingModel(Protocol):
    async def auto_agenda(self, prompt: str) -> str | dict[str, object]: ...
    async def summarize_note(self, prompt: str) -> str: ...


def speech_target(state: dict[str, object], at: float) -> str | None:
    parts = state.get("parts")
    planning = state.get("planningAt")
    if not isinstance(parts, list) or not parts or not isinstance(planning, int) or at < planning:
        return None
    first = parts[0].get("startsAt")
    if isinstance(first, int) and at < first:
        return "preparing"
    for part in parts[:-1]:  # The final reflection is private.
        start, end = part.get("startsAt"), part.get("endsAt")
        if isinstance(start, int) and isinstance(end, int) and start <= at < end:
            return str(part["partId"])
    return None


class MeetingWriter:
    def __init__(
        self,
        model: WritingModel,
        read: Callable[[], Awaitable[dict[str, object]]],
        propose: Callable[[dict[str, object]], Awaitable[str]],
        append: Callable[[dict[str, object]], Awaitable[str]],
    ) -> None:
        self.model = model
        self.read = read
        self.propose = propose
        self.append = append
        self.pending: deque[Utterance] = deque(maxlen=512)
        self.history: deque[tuple[str, Utterance]] = deque(maxlen=512)
        self.direct_finished = asyncio.Event()
        self.direct_finished.set()
        self.submit_lock = asyncio.Lock()
        self.unconfirmed: dict[str, object] | None = None
        self.last_agenda_request = float("-inf")
        self.request_number = 0
        self.coalesced = False
        self.idle_read_after = 0.0
        self.reflection_from: float | None = None
        self.generation: asyncio.Task[str | dict[str, object]] | None = None

    def begin_request(self) -> None:
        self.request_number += 1
        self.direct_finished.clear()
        if self.generation:
            self.generation.cancel()

    def clear(self) -> None:
        self.pending.clear()
        self.history.clear()
        self.coalesced = False
        self.idle_read_after = 0.0
        self.reflection_from = None

    def observe_phase(self, state: dict[str, object], sampled: float) -> None:
        # Until the host starts, batch the next few seconds before checking again.
        # Buffering those lines preserves the first words after an intervening start.
        self.idle_read_after = sampled + 5 if state.get("planningAt") is None else 0.0
        parts, now = state.get("parts"), state.get("serverNow")
        if isinstance(parts, list) and parts and isinstance(now, int):
            start = parts[-1].get("startsAt")
            if isinstance(start, int) and now >= start:
                self.reflection_from = sampled + (start - now) / 1000

    async def settle_proposal(self) -> None:
        # A lost HTTP response is ambiguous. Replay the identical call ID/body before
        # reading a plan for the next request; the Web returns the stored receipt.
        async with self.submit_lock:
            if self.unconfirmed is not None:
                body, self.unconfirmed = self.unconfirmed, None
                await self.propose(body)

    async def process(self) -> None:
        # Short overlapping clips share a snapshot and a model call per discussion part.
        while self.pending:
            await asyncio.sleep(max(1, self.idle_read_after - time.monotonic()))
            await self.direct_finished.wait()
            cutoff = time.monotonic() - HISTORY_SECONDS
            self.pending = deque(
                (
                    line
                    for line in self.pending
                    if not line.directed
                    and line.end >= cutoff
                    and (self.reflection_from is None or line.end < self.reflection_from)
                ),
                maxlen=self.pending.maxlen,
            )
            if not self.pending:
                return
            request_number = self.request_number
            await self.settle_proposal()
            state = await self.read()
            # Web samples its clock after its Firestore reads. Token refresh and request
            # processing may take seconds and must not move an earlier utterance forward.
            sampled = time.monotonic()
            if self.request_number != request_number:
                continue
            self.observe_phase(state, sampled)
            server_now = state.get("serverNow")
            if not isinstance(server_now, int):
                self.pending.clear()
                return
            groups: dict[str, list[Utterance]] = defaultdict(list)
            while self.pending:
                line = self.pending.popleft()
                if line.directed or sampled - line.end > HISTORY_SECONDS:
                    continue
                # Use the last voiced frame, even if recognition completed in a later part.
                target = speech_target(state, server_now + (line.end - sampled) * 1000)
                if target:
                    groups[target].append(line)
            planning = groups.pop("preparing", [])
            # Preserve unprocessed groups if an earlier note write fails.
            for part_id in list(groups):
                lines = groups.pop(part_id)
                try:
                    await self.write_note(part_id, lines, state)
                except Exception:
                    for waiting in [planning, *groups.values()]:
                        self.pending.extendleft(reversed(waiting))
                    raise
            if planning:
                if self.request_number != request_number:
                    self.pending.extendleft(reversed(planning))
                else:
                    await self.write_agenda(planning, state, sampled)

    async def write_agenda(
        self, lines: list[Utterance], state: dict[str, object], sampled: float
    ) -> None:
        lines = [
            line for line in lines if line.end > self.last_agenda_request and not line.directed
        ]
        if not lines:
            return
        if not self.direct_finished.is_set():
            self.pending.extendleft(reversed(lines))
            return
        labeled, aliases = labeled_plan(state)
        version = state.get("planVersion")
        if type(version) is not int or not aliases:
            return
        prompt = MeetingPrompt(
            json.dumps(
                {
                    "進行状況": labeled,
                    "今回の発言": [text for _, text in recent_speech(lines)],
                    "以前の発言": self.prior_text("preparing", lines),
                },
                ensure_ascii=False,
            ),
            aliases,
            version,
        )
        request_number = self.request_number
        self.generation = asyncio.create_task(self.model.auto_agenda(prompt.text))
        try:
            # The explicit RPC cancels only generation. An already-started POST must finish.
            (result,) = await asyncio.gather(self.generation, return_exceptions=True)
        finally:
            self.generation = None
        # A general question only pauses preparation. If the member actually asked
        # to change the plan, submit_requested records its cutoff before this batch resumes.
        if self.request_number != request_number:
            self.pending.extendleft(reversed(lines))
            return
        if isinstance(result, BaseException):
            self.pending.extendleft(reversed(lines))
            raise result
        # Include newer preparation speech once. Continuous conversation must still publish.
        server_now = state.get("serverNow")
        if (
            not self.coalesced
            and isinstance(server_now, int)
            and any(
                not line.directed
                and speech_target(state, server_now + (line.end - sampled) * 1000) == "preparing"
                for line in self.pending
            )
        ):
            self.coalesced = True
            self.pending.extendleft(reversed(lines))
            return
        self.coalesced = False
        self.history.extend(("preparing", line) for line in lines)
        if not isinstance(result, dict):
            return
        body = proposal_body(prompt, str(uuid4()), result)
        if body:
            body = {**body, "source": "automatic"}
            async with self.submit_lock:
                try:
                    await self.propose(body)
                except Exception:
                    self.unconfirmed = body
                    raise

    def prior_text(self, target: str, lines: list[Utterance]) -> list[str]:
        latest = max(line.end for line in lines)
        recent = (
            line
            for part, line in self.history
            if part == target and latest - HISTORY_SECONDS <= line.end <= latest
        )
        return [text for _, text in recent_speech(recent)]

    async def write_note(
        self, part_id: str, lines: list[Utterance], state: dict[str, object]
    ) -> None:
        await self.direct_finished.wait()
        lines = [line for line in lines if not line.directed]
        if not lines:
            return
        notes = state.get("notes")
        existing = (
            [n["text"] for n in notes if n["partId"] == part_id] if isinstance(notes, list) else []
        )
        parts = state["parts"]
        assert isinstance(parts, list)
        part = next(p for p in parts if p["partId"] == part_id)
        prompt = json.dumps(
            {
                "パート": part["name"],
                "既存のメモ": existing,
                "以前の発言": self.prior_text(part_id, lines),
                "今回の発言": [text for _, text in recent_speech(lines)],
            },
            ensure_ascii=False,
        )
        try:
            text = (await self.model.summarize_note(prompt)).strip()
        except Exception:
            self.pending.extendleft(reversed(lines))
            raise
        # A button press can overlap recognition. The explicit turn labels the selected
        # utterances before it releases this event, even if summarization finished first.
        await self.direct_finished.wait()
        if any(line.directed for line in lines):
            self.pending.extendleft(line for line in reversed(lines) if not line.directed)
            return
        self.history.extend((part_id, line) for line in lines)
        if text and text not in existing:
            await self.append(
                {"action": "note", "id": str(uuid4()), "partId": part_id, "text": text}
            )
