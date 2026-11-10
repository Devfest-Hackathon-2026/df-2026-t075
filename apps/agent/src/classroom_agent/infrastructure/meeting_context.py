"""Use an audience-bound Google ID token for the private room endpoints."""

import asyncio
import os
from threading import Lock
from urllib.parse import urlsplit

import aiohttp
import google.auth
from google.auth import impersonated_credentials
from google.auth.credentials import Credentials
from google.auth.transport.requests import Request
from google.oauth2.id_token import fetch_id_token_credentials


class ContextUnavailable(Exception):
    """The context service temporarily could not answer."""


class ContextDenied(Exception):
    def __init__(self, status: int) -> None:
        super().__init__("meeting_context_denied")
        self.status = status


def meeting_origin(value: str) -> str:
    origin = value.rstrip("/")
    url = urlsplit(origin)
    if (
        url.scheme != "https"
        and not (url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"})
    ) or (
        not url.hostname or url.username or url.password or url.path or url.query or url.fragment
    ):
        raise ValueError("invalid_meeting_origin")
    # Accessing port also rejects malformed and out-of-range ports at startup.
    _ = url.port
    return origin


class MeetingContext:
    def __init__(self, room_id: str) -> None:
        origin = meeting_origin(os.environ["MEETING_WEB_ORIGIN"])
        self.url = f"{origin}/api/internal/meetings/{room_id}/context"
        self.research_url = f"{origin}/api/internal/meetings/{room_id}/research"
        self.note_url = f"{origin}/api/internal/meetings/{room_id}/notes"
        self.proposal_url = f"{origin}/api/internal/meetings/{room_id}/proposals"
        self.credentials: Credentials | None = None
        self.lock = Lock()
        self.audience = os.environ["MEETING_WORKER_AUDIENCE"]
        self.client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8))

    def _credentials(self, request: Request) -> Credentials:
        account = os.environ.get("MEETING_WORKER_IMPERSONATE")
        if not account:
            credentials: Credentials = fetch_id_token_credentials(self.audience, request)  # type: ignore[no-untyped-call]
            return credentials
        source, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        target = impersonated_credentials.Credentials(source, account, target_scopes=[])  # type: ignore[no-untyped-call]
        return impersonated_credentials.IDTokenCredentials(  # type: ignore[no-untyped-call]
            target, target_audience=self.audience, include_email=True
        )

    def _token(self) -> str:
        # A cancelled to_thread call can still be refreshing on its thread.
        with self.lock:
            request = Request()
            if self.credentials is None:
                self.credentials = self._credentials(request)
            if not self.credentials.valid:
                self.credentials.refresh(request)  # type: ignore[no-untyped-call]
            return str(self.credentials.token)

    async def submit(self, proposal: dict[str, object]) -> str:
        return (await self._post(self.proposal_url, proposal))["status"]

    async def append_note(self, note: dict[str, object]) -> str:
        return (await self._post(self.note_url, note))["status"]

    async def research(self, body: dict[str, object]) -> dict[str, str]:
        return await self._post(self.research_url, body)

    async def _post(self, url: str, body: dict[str, object]) -> dict[str, str]:
        for attempt in range(2):
            try:
                token = "Bearer " + await asyncio.to_thread(self._token)
                async with self.client.post(
                    url,
                    json=body,
                    allow_redirects=False,
                    headers={"Authorization": token, "X-Serverless-Authorization": token},
                ) as response:
                    if response.status in (401, 403, 404, 410):
                        raise ContextDenied(response.status)
                    if response.status in (200, 400, 409):
                        result: dict[str, str] = await response.json()
                        if isinstance(result.get("status"), str):
                            return result
                    raise ValueError("meeting_write_unavailable")
            except ContextDenied:
                raise
            except Exception:
                if attempt:
                    raise ContextUnavailable("meeting_write_unavailable") from None
        raise AssertionError("unreachable")

    async def read(self) -> dict[str, object]:
        try:
            token = "Bearer " + await asyncio.to_thread(self._token)
            async with self.client.get(
                self.url,
                allow_redirects=False,
                headers={"Authorization": token, "X-Serverless-Authorization": token},
            ) as response:
                if response.status in (401, 403, 404, 410):
                    raise ContextDenied(response.status)
                if response.status != 200:
                    raise ValueError("meeting_context_unavailable")
                state: dict[str, object] = await response.json()
            return state
        except ContextDenied:
            raise
        except Exception:
            raise ContextUnavailable("meeting_context_unavailable") from None

    async def aclose(self) -> None:
        await self.client.close()
