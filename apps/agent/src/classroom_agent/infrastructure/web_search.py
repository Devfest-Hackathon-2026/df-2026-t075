"""Find public evidence without sending transcripts or fetching arbitrary result URLs."""

import asyncio
import json
import os
import re
from urllib.parse import urlsplit

import aiohttp


def public_host(url: str) -> str | None:
    try:
        link = urlsplit(url)
        host = link.hostname or ""
        if (
            link.scheme == "https"
            and link.username is None
            and link.password is None
            and link.port in (443, None)
            and re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,63}", host)
            and host.split(".")[-1] not in {"localhost", "local", "internal", "test", "invalid"}
            and not re.search(r"[\s\\]", url)
            and len(url.encode("utf-16-le")) <= 4096
        ):
            return host
    except ValueError:
        pass
    return None


async def search_pages(question: str) -> list[dict[str, str]]:
    async with (
        aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=9)) as session,
        session.post(
            "https://api.tavily.com/search",
            headers={"Authorization": "Bearer " + os.environ["TAVILY_API_KEY"]},
            json={"query": question, "max_results": 5, "search_depth": "basic"},
            allow_redirects=False,
        ) as response,
    ):
        if response.status != 200:
            raise ValueError("web_search_unavailable")
        try:
            await response.content.readexactly(256_001)
        except asyncio.IncompleteReadError as end:
            rows = json.loads(end.partial)["results"]
        else:
            raise ValueError("web_search_response_too_large")
    pages = []
    for row in rows[:5]:
        url, title, content = (row.get(key) for key in ("url", "title", "content"))
        if not all(isinstance(item, str) and item.strip() for item in (url, title, content)):
            continue
        host = public_host(url)
        if host and len(host) <= 100:
            pages.append(
                {"url": url, "title": title[:60], "publisher": host, "text": content[:1800]}
            )
    return pages


def cited_finding(
    pages: list[dict[str, str]], selection: dict[str, object]
) -> dict[str, str] | None:
    index, answer, evidence = (selection.get(key) for key in ("index", "answer", "evidence"))
    if type(index) is not int or not 0 <= index < len(pages):
        return None
    page = pages[index]
    if not (
        isinstance(answer, str)
        and answer.strip()
        and len(answer.encode("utf-16-le")) <= 480
        and isinstance(evidence, str)
        and evidence.strip()
        and evidence in page["text"]
        and len(evidence.encode("utf-16-le")) <= 440
    ):
        return None
    return {
        "source": "web",
        "answer": answer.strip(),
        "conditions": f"出典の記述「{evidence}」",
        "url": page["url"],
        "publisher": page["publisher"],
        "title": page["title"],
    }
