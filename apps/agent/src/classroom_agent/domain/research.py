import re

SLOTS = ("9〜12時", "13〜17時", "18〜22時", "9〜22時")
HALLS = ("大ホール", "小ホール")


def supported_query(query: dict[str, object]) -> bool:
    if query.get("source") == "web":
        question = query.get("question")
        return (
            set(query) == {"source", "question"}
            and isinstance(question, str)
            and bool(question.strip())
            and len(question.encode("utf-16-le")) <= 360
        )
    if query.get("source") == "population":
        country, year = query.get("country"), query.get("year")
        return (
            not query.keys() - {"source", "question", "country", "year"}
            and isinstance(country, str)
            and re.fullmatch("[A-Z]{2}", country) is not None
            and (year is None or (type(year) is int and 1960 <= year <= 2100))
        )
    return (
        query.get("source") == "hall_fee"
        and query.get("facility") == "千葉市民会館"
        and not query.keys() - {"source", "question", "facility", "hall", "day", "slot"}
        and query.get("day") in ("平日", "土日休")
        and query.get("hall") in (*HALLS, None)
        and query.get("slot") in (*SLOTS, None)
    )
