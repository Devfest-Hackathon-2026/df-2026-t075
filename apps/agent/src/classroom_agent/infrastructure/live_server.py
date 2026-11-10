"""Local test page for talking to the AI member from a browser.

The browser sends microphone audio over a WebSocket; the reply comes back as a
caption and as 24 kHz PCM. The server listens on 127.0.0.1 only and accepts
WebSocket connections from its own page only, so other sites cannot use the
developer's Google login through it.
"""

import contextlib
import json
import queue
import threading
from collections.abc import Callable, Iterator, Mapping
from importlib import resources
from logging import Logger
from typing import Protocol

from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response
from websockets.sync.server import Server, ServerConnection, serve
from websockets.typing import Origin

from classroom_agent.application.voice_check import LiveTurnResult, VoiceCheckError

INPUT_SAMPLE_RATE = 16_000


class Session(Protocol):
    @property
    def voice_sample_rate(self) -> int: ...

    def turn(self, audio: "QueueAudio", sample_rate: int, listener: "Sender") -> LiveTurnResult: ...


class QueueAudio:
    """Audio pushed by the receiving thread and read by the recognizer."""

    def __init__(self) -> None:
        self._queue: queue.Queue[bytes | None] = queue.Queue()
        self._closed = threading.Event()

    def put(self, data: bytes) -> None:
        if not self._closed.is_set():
            self._queue.put(data)

    def chunks(self) -> Iterator[bytes]:
        while (item := self._queue.get()) is not None:
            yield item

    def close(self) -> None:
        if not self._closed.is_set():
            self._closed.set()
            self._queue.put(None)

    @property
    def closed(self) -> bool:
        return self._closed.is_set()


class Sender:
    """Send turn events to the page. Messages hold no settings or credentials."""

    def __init__(self, connection: ServerConnection) -> None:
        self._connection = connection

    def event(self, kind: str, **fields: object) -> None:
        self._connection.send(json.dumps({"type": kind, **fields}, ensure_ascii=False))

    def heard(self, text: str) -> None:
        self.event("heard", text=text)

    def transcript(self, text: str) -> None:
        self.event("transcript", text=text)

    def reply(self, text: str) -> None:
        self.event("reply", text=text)

    def audio(self, pcm: bytes) -> None:
        self._connection.send(pcm)


def page_html(config: Mapping[str, object]) -> bytes:
    """Fill the page with display settings; `<` is escaped so text cannot close the script."""
    template = resources.files(__package__).joinpath("live_page.html").read_text("utf-8")
    data = json.dumps(dict(config), ensure_ascii=False).replace("<", "\\u003c")
    return template.replace("__CONFIG__", data).encode("utf-8")


def _message_type(message: str) -> object:
    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        return None
    return data.get("type") if isinstance(data, dict) else None


def _response(status: int, reason: str, content_type: str, body: bytes) -> Response:
    headers = Headers(
        [
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ]
    )
    return Response(status, reason, headers, body)


def build_server(
    *,
    host: str,
    port: int,
    page: bytes,
    sample_wav: bytes | None,
    session_factory: Callable[[], Session],
    summarize: Callable[[LiveTurnResult], dict[str, object]],
    logger: Logger,
) -> Server:
    def process_request(connection: ServerConnection, request: Request) -> Response | None:
        path = request.path.split("?", 1)[0]
        if path == "/ws":
            return None
        if path == "/":
            return _response(200, "OK", "text/html; charset=utf-8", page)
        if path == "/sample.wav" and sample_wav is not None:
            return _response(200, "OK", "audio/wav", sample_wav)
        return _response(404, "Not Found", "text/plain; charset=utf-8", b"Not Found")

    def handler(connection: ServerConnection) -> None:
        session = session_factory()
        sender = Sender(connection)
        audio: QueueAudio | None = None
        worker: threading.Thread | None = None

        def run_turn(source: QueueAudio) -> None:
            try:
                sender.event("listening")
                result = session.turn(source, INPUT_SAMPLE_RATE, sender)
                sender.event("done", **summarize(result))
            except VoiceCheckError as error:
                logger.error(
                    "live_turn_failed", extra={"stage": error.stage, "reason": error.reason}
                )
                with contextlib.suppress(ConnectionClosed):
                    sender.event("error", stage=error.stage, reason=error.reason)
            except ConnectionClosed:
                source.close()

        sender.event(
            "ready",
            inputSampleRate=INPUT_SAMPLE_RATE,
            voiceSampleRate=session.voice_sample_rate,
        )
        try:
            for message in connection:
                if isinstance(message, bytes):
                    if audio is not None:
                        audio.put(message)
                    continue
                kind = _message_type(message)
                if kind == "start" and (worker is None or not worker.is_alive()):
                    audio = QueueAudio()
                    worker = threading.Thread(target=run_turn, args=(audio,), daemon=True)
                    worker.start()
                elif kind == "stop" and audio is not None:
                    audio.close()
        except ConnectionClosed:
            pass
        finally:
            if audio is not None:
                audio.close()

    origins = [Origin(f"http://127.0.0.1:{port}"), Origin(f"http://localhost:{port}")]
    return serve(
        handler,
        host,
        port,
        origins=origins,
        process_request=process_request,
        max_size=2**20,
        compression=None,
    )
