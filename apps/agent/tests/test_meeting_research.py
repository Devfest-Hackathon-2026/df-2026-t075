import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp

from classroom_agent.application.agenda_proposal import meeting_answer
from classroom_agent.application.meeting_conversation import MeetingPrompt
from classroom_agent.application.meeting_research import MeetingResearch
from classroom_agent.infrastructure import research_sources as source


def test_lookup_reads_requested_hall_day_slot_and_column_only() -> None:
    async def run() -> None:
        query: dict[str, object] = dict(
            source="hall_fee",
            facility="千葉市民会館",
            hall="小ホール",
            day="土日休",
            slot="9〜22時",
        )
        rows = (
            "<table><tr><th>区分</th><th>加算</th><th>基本料金</th></tr>"
            "<tr><td>9〜22時</td><td>100</td><td>2,000</td></tr></table>"
        )
        weekday = "<h4>■小ホール</h4><h5>平日</h5>" + rows
        other = "<h4>■大ホール</h4><h5>土日休</h5>" + rows
        with patch.object(source, "fetch", new_callable=AsyncMock) as get:
            for key, value in (
                ("source", "other"),
                ("facility", "別の施設"),
                ("slot", "朝"),
                ("year", 2020),
            ):
                assert await source.lookup({**query, key: value}) is None
            get.assert_not_called()
            get.return_value = (weekday + other).encode()
            assert await source.lookup(query) is None
            get.return_value = (weekday + "<h5>土日休</h5>" + rows + other).encode()
            fact = await source.lookup(query)
            assert fact and "2,000円" in fact["answer"] and fact["url"].endswith("#c02")
            assert "基本料金" in fact["conditions"]
            get.assert_awaited_with(source.FEES)

    asyncio.run(run())


def test_population_checks_observation_country_indicator_and_year() -> None:
    async def run() -> None:
        query: dict[str, object] = dict(source="population", country="JP", year=2020)
        row = {
            "value": 123,
            "country": {"id": "JP", "value": "Japan"},
            "indicator": {"id": "SP.POP.TOTL"},
            "date": "2020",
        }
        with patch.object(source, "fetch", new_callable=AsyncMock) as get:
            for key, value in (("year", 1800), ("country", "会話内容")):
                assert await source.lookup({**query, key: value}) is None
            get.assert_not_called()
            missing_rows: tuple[object, ...] = (
                [{"message": [{"id": "120"}]}],
                [{}, []],
                [{}, [{**row, "value": None}]],
                [{}, [{**row, "date": "2021"}]],
            )
            for body in missing_rows:
                get.return_value = json.dumps(body).encode()
                assert await source.lookup(query) is None
            get.return_value = json.dumps([{}, [row]]).encode()
            for year in (2020, None):
                result = await source.lookup({**query, "year": year, "question": "private"})
                assert result and "123人" in result["answer"] and "2020" in result["conditions"]
                assert "private" not in get.await_args_list[-1].args[0]

    asyncio.run(run())


def test_direct_request_starts_once_and_releases_turn_before_lookup_finishes() -> None:
    async def run() -> None:
        gate = asyncio.Event()
        calls = 0

        async def search(_: dict[str, object]) -> dict[str, str]:
            nonlocal calls
            calls += 1
            await gate.wait()
            return {"answer": "確認した料金"}

        write = AsyncMock(return_value={"status": "pending"})
        research = MeetingResearch(write, search)
        query: dict[str, object] = {
            "source": "hall_fee",
            "facility": "千葉市民会館",
            "day": "土日休",
            "question": "休日の利用料は？",
        }
        for invalid in ({"source": "unsupported"}, {"day": None}):
            assert "対応" in await research.start("unsupported", {**query, **invalid})
        write.assert_not_awaited()
        generate = AsyncMock(return_value={"research": query})
        submit = AsyncMock()
        for _ in range(2):
            assert (
                await meeting_answer(
                    MeetingPrompt("request", {}, None), "turn", generate, submit, research.start
                )
                == ""
            )
        await asyncio.sleep(0)
        assert calls == 1 and write.await_count == 2
        assert write.await_args_list[0] == write.await_args_list[1]
        assert write.await_args_list[-1].args[0]["action"] == "start"
        gate.set()
        await asyncio.gather(*research.jobs.values())
        assert write.await_args_list[-1].args[0]["status"] == "verified"
        submit.assert_not_awaited()

        research.lookup = AsyncMock(return_value=None)
        await research.start("missing", query)
        await asyncio.gather(*research.jobs.values())
        assert write.await_args_list[-1].args[0]["status"] == "unverified"
        research.lookup = AsyncMock(side_effect=TimeoutError)
        await research.start("outage", query)
        await asyncio.gather(*research.jobs.values())
        assert write.await_args_list[-1].args[0]["status"] == "failed"
        for status in ("busy", "full", "timeout"):
            write.return_value = {"status": status}
            assert await research.start("other", query)
            assert not research.jobs
        assert await research.start("invalid", {})
        write.return_value = {"status": "pending"}
        await research.start("cancel", query)
        await research.close()
        assert write.await_args_list[-1].args[0]["action"] == "start"

    asyncio.run(run())


def test_lookup_fetch_refuses_redirects_and_oversized_responses() -> None:
    async def run() -> None:
        with patch.object(aiohttp, "ClientSession") as factory:
            session = factory.return_value.__aenter__.return_value
            response = MagicMock(status=200)
            response.content.readexactly = AsyncMock(
                side_effect=asyncio.IncompleteReadError(b"ok", 512001)
            )
            session.get = MagicMock()
            session.get.return_value.__aenter__ = AsyncMock(return_value=response)
            assert await source.fetch(source.FEES) == b"ok"
            session.get.assert_called_once_with(source.FEES, allow_redirects=False)
            for status in (200, 302):
                response.status = status
                response.content.readexactly.side_effect = None
                try:
                    await source.fetch(source.FEES)
                except ValueError:
                    pass
                else:
                    raise AssertionError("untrusted response accepted")

    asyncio.run(run())


def test_web_search_only_cites_a_returned_page_with_matching_evidence() -> None:
    from classroom_agent.domain.research import supported_query
    from classroom_agent.infrastructure.web_search import cited_finding, public_host

    query = {"source": "web", "question": "公開資料の条件を調べて"}
    assert supported_query(dict(query))
    assert not supported_query({**query, "transcript": "private"})
    page = {
        "text": "例年10月に開催する。",
        "url": "https://example.org/meeting",
        "title": "開催要領",
        "publisher": "example.org",
    }
    result: dict[str, object] = {
        "index": 0,
        "evidence": "例年10月に開催",
        "answer": "開催は例年10月です。",
    }
    assert public_host(page["url"]) == page["publisher"]
    for unsafe in (
        "javascript:alert(1)",
        "https://localhost/",
        "https://user@example.org/",
        "https://127.0.0.1/",
        "https://example.org:444/",
        "https://foo.internal/",
    ):
        assert public_host(unsafe) is None
    assert cited_finding([page], result) == {
        "answer": result["answer"],
        "source": "web",
        "url": page["url"],
        "title": page["title"],
        "publisher": page["publisher"],
        "conditions": "出典の記述「例年10月に開催」",
    }
    for bad in ({"index": -1}, {"index": True}, {"evidence": "来年12月"}, {"answer": ""}):
        assert cited_finding([page], {**result, **bad}) is None
