import asyncio
import json
import logging
from contextlib import AsyncExitStack
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from classroom_agent.bootstrap import voice_worker


def test_worker_capacity_is_one_trial_at_a_time() -> None:
    server = MagicMock()
    server.active_jobs = []
    assert voice_worker.probe_load(server) == 0.0
    server.active_jobs = [MagicMock()]
    assert voice_worker.probe_load(server) == 1.0


def test_worker_requires_its_own_explicit_settings(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for field in ("LIVEKIT_URL", "LIVEKIT_API_SECRET", "GOOGLE_CLOUD_PROJECT"):
        monkeypatch.delenv(field, raising=False)
    monkeypatch.setenv("LIVEKIT_API_KEY", "private-value")
    with patch.object(logging, "basicConfig"):
        assert voice_worker.main() == 2
    out = capsys.readouterr().out
    assert "LIVEKIT_API_SECRET" in out and "private-value" not in out


@pytest.mark.parametrize(
    ("field", "value"), [("GEMINI_MODEL", "gemini-9"), ("GEMINI_THINKING_LEVEL", "minimal")]
)
def test_worker_rejects_unsupported_reply_settings(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], field: str, value: str
) -> None:
    for key in ("LIVEKIT_URL", "LIVEKIT_API_SECRET", "LIVEKIT_API_KEY", "GOOGLE_CLOUD_PROJECT"):
        monkeypatch.setenv(key, "private-value")
    for key in ("GEMINI_MODEL", "GEMINI_THINKING_LEVEL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv(field, value)
    with (
        patch.object(voice_worker, "AgentServer") as server,
        patch.object(logging, "basicConfig"),
    ):
        assert voice_worker.main() == 2
        server.assert_not_called()
    assert json.loads(capsys.readouterr().out)["invalid_fields"] == [field]


@pytest.mark.parametrize(
    "error,code", [(None, 0), (KeyboardInterrupt(), 0), (RuntimeError("private-value"), 1)]
)
def test_worker_stops_closes_the_server_and_hides_failures(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    error: BaseException | None,
    code: int,
) -> None:
    for key in ("LIVEKIT_URL", "LIVEKIT_API_SECRET", "LIVEKIT_API_KEY", "GOOGLE_CLOUD_PROJECT"):
        monkeypatch.setenv(key, "private-value")
    with (
        patch.object(voice_worker, "AgentServer") as server,
        patch.object(logging, "basicConfig"),
    ):
        # A cancelled serving task mirrors SIGINT without injecting a process-wide signal.
        failure = asyncio.CancelledError() if isinstance(error, KeyboardInterrupt) else error
        server.return_value.run = AsyncMock(side_effect=failure)
        server.return_value.aclose = AsyncMock()
        assert voice_worker.main() == code
        server.return_value.rtc_session.assert_called_once()
        server.return_value.on.call_args.args[1]("private-value", "private-value")
        server.return_value.aclose.assert_awaited_once()
    assert "private-value" not in capsys.readouterr().out


def test_job_closes_google_clients_after_the_room(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        ctx = MagicMock()
        monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test-project")
        monkeypatch.setenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
        monkeypatch.setenv("GEMINI_THINKING_LEVEL", "default")
        with (
            patch.object(voice_worker, "GoogleVoice") as google,
            patch.object(voice_worker, "run_probe_room", new_callable=AsyncMock) as run_room,
        ):
            google.return_value.aclose = AsyncMock()

            async with AsyncExitStack() as stack:
                await voice_worker.job(ctx)
                assert run_room.call_args.args[1](stack) is google.return_value
            google.assert_called_once_with(
                "test-project",
                "gemini-3.5-flash-lite",
                "default",
                member_name="ノト",
            )
            google.return_value.aclose.assert_awaited_once()

    asyncio.run(check())
