"""JSON logging for operational events with an explicit field allowlist."""

import json
import logging
import sys
from datetime import UTC, datetime
from typing import TextIO


class JsonFormatter(logging.Formatter):
    """Keep arbitrary extras and exception text out of operational logs.

    Event messages and allowed extras must still be non-sensitive: this formatter
    cannot recognize secrets embedded in free text. Use static event names.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(
                timespec="milliseconds"
            ),
            "severity": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
        }
        for field in ("environment", "mode", "invalid_fields", "stage", "reason", "status_code"):
            if hasattr(record, field):
                payload[field] = getattr(record, field)
        if record.exc_info is not None and record.exc_info[0] is not None:
            payload["error_type"] = record.exc_info[0].__name__
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(level: str, *, stream: TextIO | None = None) -> logging.Logger:
    """Configure only this package's logger; repeated setup does not duplicate logs."""
    logger = logging.getLogger("classroom_agent")
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(JsonFormatter())
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False
    return logger
