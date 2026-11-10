import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from classroom_agent.infrastructure.meeting_context import (
    ContextDenied,
    ContextUnavailable,
    MeetingContext,
)


def test_context_goes_only_to_configured_origin_and_errors_hide_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> None:
        monkeypatch.setenv("MEETING_WORKER_AUDIENCE", "local-test")
        for bad in (
            "http://remote.example",
            "https://user@example.org",
            "https://example.org/path",
        ):
            monkeypatch.setenv("MEETING_WEB_ORIGIN", bad)
            with pytest.raises(ValueError, match="invalid_meeting_origin"):
                MeetingContext("room")
        monkeypatch.setenv("MEETING_WEB_ORIGIN", "http://127.0.0.1:3100")
        context = MeetingContext("room")
        try:
            response = MagicMock(status=200)
            response.json = AsyncMock(return_value={"version": 3})
            with (
                patch.object(context, "_token", return_value="test-token"),
                patch.object(context.client, "get") as get,
            ):
                get.return_value.__aenter__ = AsyncMock(return_value=response)
                assert await context.read() == {"version": 3}
                assert get.call_args.args == (
                    "http://127.0.0.1:3100/api/internal/meetings/room/context",
                )
                assert get.call_args.kwargs["allow_redirects"] is False
                assert get.call_args.kwargs["headers"]["Authorization"] == "Bearer test-token"
                response.status = 403
                with pytest.raises(ContextDenied) as denied:
                    await context.read()
                assert denied.value.status == 403
                response.status = 503
                with pytest.raises(ContextUnavailable):
                    await context.read()
        finally:
            await context.aclose()

    asyncio.run(run())


def test_tokens_are_reused_until_google_marks_them_near_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> None:
        monkeypatch.setenv("MEETING_WEB_ORIGIN", "http://localhost:3100")
        monkeypatch.setenv("MEETING_WORKER_AUDIENCE", "service")
        ctx = MeetingContext("room")
        credentials = MagicMock(valid=False, token=None)

        def refresh(_: object) -> None:
            credentials.valid = True
            credentials.token = "test-token"

        credentials.refresh.side_effect = refresh
        try:
            with patch.object(ctx, "_credentials", return_value=credentials) as create:
                await asyncio.gather(*(asyncio.to_thread(ctx._token) for _ in range(3)))
                create.assert_called_once()
                credentials.refresh.assert_called_once()
                credentials.valid = False
                assert ctx._token() == "test-token" and credentials.refresh.call_count == 2
        finally:
            await ctx.aclose()

    asyncio.run(run())


def test_proposal_retry_reuses_body_and_never_follows_redirects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> None:
        monkeypatch.setenv("MEETING_WEB_ORIGIN", "http://localhost:3100")
        monkeypatch.setenv("MEETING_WORKER_AUDIENCE", "service")
        context = MeetingContext("room")
        try:
            body: dict[str, object] = {"id": "call"}
            response = MagicMock(status=200)
            response.json = AsyncMock(return_value={"status": "pending"})
            with (
                patch.object(context, "_token", return_value="test"),
                patch.object(context.client, "post") as post,
            ):
                post.return_value.__aenter__ = AsyncMock(side_effect=[TimeoutError(), response])
                assert await context.submit(body) == "pending"
                assert post.call_args_list[0] == post.call_args_list[1]
                assert post.call_args.kwargs["json"] is body
                assert not post.call_args.kwargs["allow_redirects"]
                post.return_value.__aenter__ = AsyncMock(return_value=response)
                response.status = 410
                with pytest.raises(ContextDenied):
                    await context.submit(body)
                response.status = 503
                with pytest.raises(ContextUnavailable):
                    await context.submit(body)
        finally:
            await context.aclose()

    asyncio.run(run())
