import asyncio
import json
import logging
from contextlib import AsyncExitStack
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from livekit.agents import JobRequest

from classroom_agent.bootstrap import voice_worker


@pytest.mark.parametrize(
    ("capacity", "jobs", "load"),
    [(1, 0, 0.0), (1, 1, 1.0), (5, 0, 0.0), (5, 3, 0.6), (5, 5, 1.0), (5, 6, 1.0)],
)
def test_room_load(capacity: int, jobs: int, load: float) -> None:
    server = MagicMock()
    server.active_jobs = [MagicMock() for _ in range(jobs)]
    assert voice_worker.room_load(server, capacity=capacity) == load


def test_pending_jobs_share_the_limit_with_running_jobs() -> None:
    async def check() -> None:
        server = MagicMock()
        running = MagicMock()
        running.job.id = "already-running"
        server.active_jobs = [running]
        handle = voice_worker.meeting_request_handler(server, capacity=6)

        def request(job_id: str) -> AsyncMock:
            req = AsyncMock(spec=JobRequest)
            req.id = job_id
            req.room.name = "meeting-2495a326-91fe-4a3d-931e-4593f77fabd2"
            req.job.metadata = "ノト"
            return req

        started = asyncio.Queue[None]()
        release = asyncio.Event()

        async def wait_for_assignment(*, name: str, identity: str) -> None:
            started.put_nowait(None)
            await release.wait()

        tasks: list[asyncio.Future[None]] = []
        for i in range(5):
            req = request(str(i))
            req.accept.side_effect = wait_for_assignment
            tasks.append(asyncio.ensure_future(handle(req)))
        try:
            for _ in tasks:
                await asyncio.wait_for(started.get(), timeout=2)
            overflow = request("next")
            await handle(overflow)
            overflow.reject.assert_awaited_once_with(terminate=False)
            overflow.accept.assert_not_awaited()

            tasks[0].cancel()
            with pytest.raises(asyncio.CancelledError):
                await tasks[0]
            await handle(overflow)
            overflow.accept.assert_awaited_once()

            # The SDK can expose a job as running before its accept call returns.
            launching = MagicMock()
            launching.job.id = "1"
            server.active_jobs.append(launching)
            available = request("another")
            await handle(available)
            available.accept.assert_awaited_once()
        finally:
            release.set()
            await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(check())


@pytest.mark.parametrize(
    ("meeting", "value", "expected"),
    [(True, None, 1), (True, "5", 5), (False, "5", 1), (True, "11", None), (True, "bad", None)],
)
def test_worker_room_limit(
    monkeypatch: pytest.MonkeyPatch, meeting: bool, value: str | None, expected: int | None
) -> None:
    for key in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "GOOGLE_CLOUD_PROJECT"):
        monkeypatch.setenv(key, "test-value")
    monkeypatch.setenv("MEETING_WEB_ORIGIN", "https://example.org")
    monkeypatch.setenv("MEETING_WORKER_AUDIENCE", "https://example.org")
    if value is None:
        monkeypatch.delenv("MEETING_MAX_ROOMS_PER_WORKER", raising=False)
    else:
        monkeypatch.setenv("MEETING_MAX_ROOMS_PER_WORKER", value)
    with patch.object(logging, "basicConfig"), patch.object(voice_worker, "serve") as serve:
        if expected is None:
            assert voice_worker.main(meeting=meeting) == 2
            serve.assert_not_called()
        else:
            assert voice_worker.main(meeting=meeting) == 0
            serve.assert_awaited_once_with(meeting, expected)


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
