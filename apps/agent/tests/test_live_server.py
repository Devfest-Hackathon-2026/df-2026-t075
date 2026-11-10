"""The local test server, exercised over a real loopback WebSocket."""

import json
import logging
import socket
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

import pytest
from websockets.exceptions import InvalidStatus
from websockets.sync.client import ClientConnection, connect
from websockets.typing import Origin

from classroom_agent.application.voice_check import LiveTurnResult, VoiceCheckError
from classroom_agent.domain.voice_cost import Tokens, TurnUsage
from classroom_agent.infrastructure.live_server import QueueAudio, Sender, build_server, page_html


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


class Session:
    """Read audio until it is closed, then reply; or fail with the given error."""

    voice_sample_rate = 24_000

    def __init__(self, error: VoiceCheckError | None = None) -> None:
        self.error = error
        self.received: list[bytes] = []

    def turn(self, audio: QueueAudio, sample_rate: int, listener: Sender) -> LiveTurnResult:
        assert sample_rate == 16_000
        for chunk in audio.chunks():
            self.received.append(chunk)
        if self.error is not None:
            raise self.error
        listener.heard("こんにちは")
        listener.transcript("こんにちは")
        listener.reply("どうしましたか？")
        listener.audio(b"\x01\x00\x02\x00")
        return LiveTurnResult(
            "こんにちは",
            "どうしましたか？",
            0.5,
            0.7,
            0.4,
            TurnUsage(2, Tokens(1, 1), Tokens(1, 1)),
        )


@pytest.fixture
def server(request: pytest.FixtureRequest) -> Iterator[tuple[int, Session]]:
    session = getattr(request, "param", None) or Session()
    port = free_port()
    running = build_server(
        host="127.0.0.1",
        port=port,
        page=b"<p>page</p>",
        sample_wav=b"RIFF-sample",
        session_factory=lambda: session,
        summarize=lambda result: {"replyDone": result.reply_wait},
        logger=logging.getLogger("test-live-server"),
    )
    thread = threading.Thread(target=running.serve_forever, daemon=True)
    thread.start()
    try:
        yield port, session
    finally:
        running.shutdown()
        thread.join(timeout=5)


def open_socket(port: int) -> ClientConnection:
    return connect(f"ws://127.0.0.1:{port}/ws", origin=Origin(f"http://127.0.0.1:{port}"))


def messages_until(connection: ClientConnection, kind: str) -> list[Any]:
    received: list[Any] = []
    while True:
        message = connection.recv(timeout=5)
        received.append(message if isinstance(message, bytes) else json.loads(message))
        if isinstance(received[-1], dict) and received[-1]["type"] == kind:
            return received


def test_page_sample_and_unknown_paths(server: tuple[int, Session]) -> None:
    port, _ = server
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as response:
        assert response.read() == b"<p>page</p>"
        assert response.headers["Content-Type"] == "text/html; charset=utf-8"
        assert response.headers["Cache-Control"] == "no-store"
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/sample.wav?x=1") as response:
        assert response.read() == b"RIFF-sample"
    with pytest.raises(urllib.error.HTTPError) as raised:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/secret")
    assert raised.value.code == 404
    raised.value.close()


def test_a_turn_relays_audio_and_returns_caption_voice_and_summary(
    server: tuple[int, Session],
) -> None:
    port, session = server
    with open_socket(port) as connection:
        ready = json.loads(connection.recv(timeout=5))
        assert ready == {"type": "ready", "inputSampleRate": 16_000, "voiceSampleRate": 24_000}
        connection.send("not json")
        connection.send(json.dumps({"type": "start"}))
        assert json.loads(connection.recv(timeout=5)) == {"type": "listening"}
        connection.send(b"\x10\x00\x20\x00")
        connection.send(json.dumps({"type": "stop"}))
        received = messages_until(connection, "done")

    assert received == [
        {"type": "heard", "text": "こんにちは"},
        {"type": "transcript", "text": "こんにちは"},
        {"type": "reply", "text": "どうしましたか？"},
        b"\x01\x00\x02\x00",
        {"type": "done", "replyDone": 0.7},
    ]
    assert session.received == [b"\x10\x00\x20\x00"]


@pytest.mark.parametrize(
    "server", [Session(VoiceCheckError("reply", "ReadTimeout"))], indirect=True
)
def test_failures_reach_the_page_with_stage_and_reason_only(
    server: tuple[int, Session], caplog: pytest.LogCaptureFixture
) -> None:
    port, _ = server
    with open_socket(port) as connection:
        connection.recv(timeout=5)
        connection.send(json.dumps({"type": "start"}))
        connection.send(json.dumps({"type": "stop"}))
        received = messages_until(connection, "error")
    assert received[-1] == {"type": "error", "stage": "reply", "reason": "ReadTimeout"}
    assert [record.getMessage() for record in caplog.records] == ["live_turn_failed"]


def test_other_sites_cannot_open_the_socket(server: tuple[int, Session]) -> None:
    port, _ = server
    with pytest.raises(InvalidStatus) as raised:
        connect(f"ws://127.0.0.1:{port}/ws", origin=Origin("https://example.com"))
    assert raised.value.response.status_code == 403


def test_queue_audio_ends_when_closed_and_ignores_late_audio() -> None:
    audio = QueueAudio()
    audio.put(b"a")
    audio.close()
    audio.put(b"late")
    audio.close()
    assert list(audio.chunks()) == [b"a"]
    assert audio.closed


def test_page_settings_cannot_close_the_script_tag() -> None:
    page = page_html({"topic": "</script><script>alert(1)</script>", "hasSample": False})
    assert b"</script><script>alert(1)" not in page
    assert b"\\u003c/script>" in page
