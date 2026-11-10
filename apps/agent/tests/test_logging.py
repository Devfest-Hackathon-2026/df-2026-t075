import json
import logging
from datetime import datetime
from io import StringIO

from classroom_agent.infrastructure.logging import configure_logging


def test_json_log_keeps_only_allowed_context_and_escapes_line_breaks() -> None:
    stream = StringIO()
    logger = configure_logging("INFO", stream=stream)
    logger.info(
        "configuration\nvalid",
        extra={"environment": "test", "api_key": "secret-value", "unexpected": object()},
    )
    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["event"] == "configuration\nvalid"
    assert payload["severity"] == "INFO"
    assert payload["environment"] == "test"
    assert datetime.fromisoformat(payload["timestamp"]).utcoffset() is not None
    assert "api_key" not in payload
    assert "unexpected" not in payload
    assert "secret-value" not in stream.getvalue()


def test_exception_logs_do_not_include_raw_exception_message_or_traceback() -> None:
    stream = StringIO()
    logger = configure_logging("INFO", stream=stream)
    try:
        raise RuntimeError("provider failed with secret-value")
    except RuntimeError:
        logger.exception("operation_failed")
    payload = json.loads(stream.getvalue())
    assert payload["error_type"] == "RuntimeError"
    assert "secret-value" not in stream.getvalue()
    assert "Traceback" not in stream.getvalue()


def test_repeated_setup_respects_level_without_duplicate_handlers() -> None:
    stream = StringIO()
    configure_logging("INFO", stream=stream)
    logger = configure_logging("WARNING", stream=stream)
    logger.info("hidden_event")
    logger.warning("visible_event")
    assert len(stream.getvalue().splitlines()) == 1
    assert json.loads(stream.getvalue())["event"] == "visible_event"


def test_setup_does_not_modify_root_logger() -> None:
    root_logger = logging.getLogger()
    original_handlers = tuple(root_logger.handlers)
    original_level = root_logger.level
    configure_logging("DEBUG", stream=StringIO())
    assert tuple(root_logger.handlers) == original_handlers
    assert root_logger.level == original_level
