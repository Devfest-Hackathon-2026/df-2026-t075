"""Register a request before starting a cancellable room-local lookup."""

import asyncio
from collections.abc import Awaitable, Callable
from uuid import NAMESPACE_URL, uuid5

from classroom_agent.domain.research import supported_query

ResearchWrite = Callable[[dict[str, object]], Awaitable[dict[str, str]]]
Lookup = Callable[[dict[str, object]], Awaitable[dict[str, str] | None]]


class MeetingResearch:
    def __init__(self, write: ResearchWrite, lookup: Lookup) -> None:
        self.write = write
        self.lookup = lookup
        self.jobs: dict[str, asyncio.Task[None]] = {}

    async def start(self, request_id: str, query: dict[str, object]) -> str:
        question = query.get("question")
        if (
            not isinstance(question, str)
            or not question.strip()
            or len(question.encode("utf-16-le")) > 360
        ):
            return "調べる対象と条件をもう一度教えてください。"
        if not supported_query(query):
            return "この調査条件にはまだ対応していません。"
        research_id = str(uuid5(NAMESPACE_URL, "ainote/research/" + request_id))
        receipt = await self.write({"action": "start", "id": research_id, "question": question})
        status = receipt["status"]
        if status == "ended":
            return "予定の終了時刻を過ぎたため、調査を開始できません。"
        if status in ("invalid-research", "conflict"):
            return "調査を登録できませんでした。条件を確認してもう一度頼んでください。"
        if status == "busy":
            return "先の調査が終わってから、もう一度依頼してください。"
        if status == "full":
            return "この部屋の調査は上限に達しました。"
        if status == "pending":
            if research_id not in self.jobs:
                job = asyncio.create_task(self.finish(research_id, query))
                self.jobs[research_id] = job
                job.add_done_callback(lambda _: self.jobs.pop(research_id, None))
            # The persistent tile acknowledges acceptance without taking the floor.
            return ""
        return "参考資料で調査の状態を確認してください。"

    async def finish(self, research_id: str, query: dict[str, object]) -> None:
        body: dict[str, object] = {"action": "finish", "id": research_id}
        try:
            finding = await self.lookup(query)
        except Exception:
            body["status"] = "failed"
        else:
            body["status"] = "verified" if finding else "unverified"
            if finding:
                body["finding"] = finding
        try:
            await self.write(body)
        except Exception:
            # An unacknowledged write is retried by the adapter. Web owns expiry after that.
            return

    async def close(self) -> None:
        tasks = list(self.jobs.values())
        for job in tasks:
            job.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
