"""Read only the selected public source. No room text, tokens or model URLs leave the worker."""

import asyncio
import json
import re
from datetime import datetime
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

import aiohttp

from classroom_agent.domain.research import HALLS, SLOTS, supported_query

FEES = "https://www.f-cp.jp/shimin/guide/guide05/"


class FeeTable(HTMLParser):
    """Associate each base fee with its hall, day heading and time row."""

    def __init__(self) -> None:
        super().__init__()
        self.hall = self.day = self.tag = self.text = ""
        self.base_column: int | None = None
        self.cells: list[str] = []
        self.prices: dict[tuple[str, str, str], str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("h4", "h5", "td", "th"):
            self.tag, self.text = tag, ""
        elif tag == "tr":
            self.cells = []
        elif tag == "table":
            self.base_column = None

    def handle_data(self, data: str) -> None:
        if self.tag:
            self.text += data

    def handle_endtag(self, tag: str) -> None:
        if tag == self.tag:
            value = self.text.strip()
            if tag == "h4":
                self.hall, self.day = value.removeprefix("■"), ""
            elif tag == "h5":
                self.day = value
            else:
                self.cells.append(value)
            self.tag = ""
        if tag == "table":
            self.day = ""
        if tag == "tr" and self.cells:
            if self.cells[0] == "区分" and "基本料金" in self.cells:
                self.base_column = self.cells.index("基本料金")
            elif self.base_column is not None and self.base_column < len(self.cells):
                fee = self.cells[self.base_column]
                if self.cells[0] in SLOTS and re.fullmatch(r"[0-9]{1,3}(?:,[0-9]{3})*", fee):
                    self.prices[self.hall, self.day, self.cells[0]] = fee


async def fetch(url: str) -> bytes:
    # Separate, unauthenticated session. Refuse redirects and bound the decompressed response.
    async with (
        aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as session,
        session.get(url, allow_redirects=False) as response,
    ):
        if response.status != 200:
            raise ValueError("research_source_unavailable")
        try:
            await response.content.readexactly(512_001)
        except asyncio.IncompleteReadError as eof:
            return eof.partial
        raise ValueError("research_source_too_large")


async def lookup(query: dict[str, object]) -> dict[str, str] | None:
    if not supported_query(query):
        return None
    if query["source"] == "population":
        country, year = str(query["country"]), query.get("year")
        period = f"date={year}" if year is not None else "mrnev=1"
        url = f"https://api.worldbank.org/v2/country/{country}/indicator/SP.POP.TOTL"
        body = json.loads(await fetch(f"{url}?format=json&source=2&{period}"))
        # The API also returns a JSON error envelope with HTTP 200.
        if not isinstance(body, list) or len(body) != 2:
            if (
                isinstance(body, list)
                and len(body) == 1
                and isinstance(body[0], dict)
                and any(str(m.get("id")) == "120" for m in body[0].get("message", []))
            ):
                return None  # Invalid parameter, e.g. an unknown economy code.
            raise ValueError("unexpected_population_response")
        if not body[1]:
            return None
        row = body[1][0]
        value, date = row["value"], row["date"]
        if (
            row["indicator"]["id"] != "SP.POP.TOTL"
            or row["country"]["id"] != country
            or type(value) is not int
            or not re.fullmatch(r"[0-9]{4}", date)
            or (year is not None and date != str(year))
        ):
            return None
        country_name = {"JP": "日本", "US": "米国", "CN": "中国", "GB": "英国", "KR": "韓国"}.get(
            country, row["country"]["value"]
        )
        return {
            "license": "CC-BY-4.0",
            "answer": f"{country_name}の{date}年の総人口は{value:,}人です。",
            "conditions": f"{date}年の年央推計。国・地域全体の居住人口。",
            "title": "World Development Indicators · Population, total",
            "publisher": "World Bank",
            "url": f"https://data.worldbank.org/indicator/SP.POP.TOTL?locations={country}"
            f"&start={date}&end={date}",
        }
    hall, day, slot = query.get("hall"), query["day"], query.get("slot")
    table = FeeTable()
    table.feed((await fetch(FEES)).decode("utf-8"))
    sections = []
    for name in HALLS if hall is None else (str(hall),):
        fees = []
        for time in SLOTS if slot is None else (str(slot),):
            amount = table.prices.get((name, str(day), time))
            if amount is None:
                return None
            fees.append(f"{time} {amount}円")
        sections.append(f"{name}（" + "、".join(fees) + "）")
    as_of = datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()
    return {
        "answer": f"千葉市民会館の{day}の基本料金は、" + "、".join(sections) + "です。",
        "conditions": (
            f"{as_of}確認の現行表。各時間区分1回の基本料金。"
            "市外・有料入場・営利の加算、設備料は別。"
        ),
        "title": "施設利用料金表（市民会館）",
        "publisher": "公益財団法人千葉市文化振興財団",
        "url": FEES + {"小ホール": "#c02", "大ホール": "#c01"}.get(str(hall), ""),
    }
