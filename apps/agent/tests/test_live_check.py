import argparse
import io
import json
import socket
import threading
from pathlib import Path
from typing import Any

import pytest
from voice_samples import speech
from websockets.sync.server import Server

from classroom_agent.application.voice_check import LiveSession, LiveTurnResult
from classroom_agent.bootstrap import live_check
from classroom_agent.bootstrap import main as main_module
from classroom_agent.bootstrap.settings import VoiceSettings
from classroom_agent.bootstrap.voice_check import Adapters
from classroom_agent.domain.voice_cost import Tokens, TurnUsage
from classroom_agent.infrastructure import live_server
from classroom_agent.infrastructure.wav_files import write_wav

ENVIRON = {"GOOGLE_CLOUD_PROJECT": "demo-project", "APP_ENV": "test"}


class Synthesizer:
    sample_rate = 24_000


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


PORT = free_port()


def parse(*extra: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    live_check.add_arguments(parser)
    return parser.parse_args(["--port", str(PORT), *extra])


def run(
    args: argparse.Namespace, environ: dict[str, str] | None = None
) -> tuple[int, str, dict[str, Any]]:
    captured: dict[str, Any] = {}

    def adapters(settings: VoiceSettings, phrases: tuple[str, ...]) -> Adapters:
        captured["phrases"] = phrases
        return Adapters(recognizer=object(), writer=object(), synthesizer=Synthesizer())  # type: ignore[arg-type]

    def start(server: Server) -> None:
        captured["server"] = server
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        server.shutdown()
        thread.join(timeout=5)

    def build_server(**kwargs: Any) -> Server:
        captured.update(kwargs)
        return real_build(**kwargs)

    real_build = live_server.build_server
    stdout = io.StringIO()
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(live_check, "build_server", build_server)
        code = live_check.run(
            args, environ or ENVIRON, stdout=stdout, adapters_factory=adapters, start=start
        )
    return code, stdout.getvalue(), captured


def test_serves_on_loopback_with_a_session_per_page(tmp_path: Path) -> None:
    sample = tmp_path / "sample.wav"
    write_wav(sample, speech())
    code, out, captured = run(
        parse("--sample", str(sample), "--phrase", "ノト", "--phrase", "読書会")
    )

    assert code == 0
    assert f"http://127.0.0.1:{PORT}/" in out
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == PORT
    assert captured["phrases"] == ("ノト", "読書会")
    assert captured["sample_wav"] == sample.read_bytes()
    page = captured["page"].decode()
    assert '"hasSample": true' in page
    assert "gemini-3.8-flash-tts" in page

    first = captured["session_factory"]()
    assert isinstance(first, LiveSession)
    assert first is not captured["session_factory"]()
    assert first.voice_sample_rate == 24_000


def test_summary_has_waits_and_cost() -> None:
    result = LiveTurnResult("t", "r", 0.51234, 0.8, 0.6, TurnUsage(60, Tokens(0, 0), Tokens(0, 0)))
    settings = VoiceSettings.from_environ(ENVIRON)
    assert live_check.summarize_for(settings)(result) == {
        "replyFirst": 0.512,
        "replyDone": 0.8,
        "firstAudio": 0.6,
        "costUsd": pytest.approx(0.016),
    }
    incomplete = LiveTurnResult("t", "r", 0.1, 0.2, 0.3, TurnUsage(60, Tokens(0, 0), None))
    assert live_check.summarize_for(settings)(incomplete)["costUsd"] is None
    unknown = VoiceSettings.from_environ({**ENVIRON, "GEMINI_MODEL": "new-model"})
    assert live_check.summarize_for(unknown)(result)["costUsd"] is None


@pytest.mark.parametrize(
    ("args", "environ", "reason"),
    [
        (("--port", "80"), ENVIRON, "invalid_port"),
        (("--patience", "5"), ENVIRON, "invalid_patience"),
        (("--sample", "missing.wav"), ENVIRON, "audio_file_not_found"),
    ],
)
def test_invalid_input_stops_before_serving(
    capsys: pytest.CaptureFixture[str],
    args: tuple[str, ...],
    environ: dict[str, str],
    reason: str,
) -> None:
    code, _, captured = run(parse(*args), environ)
    assert code == 2
    assert "server" not in captured
    assert json.loads(capsys.readouterr().out)["reason"] == reason


def test_missing_settings_and_busy_ports_are_reported(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    code, *_ = run(parse(), {"APP_ENV": "test"})
    assert code == 2
    assert json.loads(capsys.readouterr().out)["invalid_fields"] == ["GOOGLE_CLOUD_PROJECT"]

    def busy(**_: Any) -> Server:
        raise OSError("address in use")

    monkeypatch.setattr(live_check, "build_server", busy)
    code = live_check.run(
        parse(),
        ENVIRON,
        stdout=io.StringIO(),
        adapters_factory=lambda *_: Adapters(object(), object(), Synthesizer()),  # type: ignore[arg-type]
    )
    assert code == 2
    assert json.loads(capsys.readouterr().out)["reason"] == "port_unavailable"


class FakeServer:
    def __init__(self, interrupt: bool) -> None:
        self.interrupt = interrupt
        self.stopped = False

    def serve_forever(self) -> None:
        if self.interrupt:
            raise KeyboardInterrupt

    def shutdown(self) -> None:
        self.stopped = True


@pytest.mark.parametrize("interrupt", [True, False])
def test_ctrl_c_stops_the_server(interrupt: bool) -> None:
    server = FakeServer(interrupt)
    live_check._serve_until_interrupted(server)  # type: ignore[arg-type]
    assert server.stopped


def test_main_dispatches_the_live_check(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[argparse.Namespace] = []

    def fake_run(args: argparse.Namespace, *_: Any, **__: Any) -> int:
        seen.append(args)
        return 5

    monkeypatch.setattr(live_check, "run", fake_run)
    assert main_module.main(["live-check", "--port", "9000"]) == 5
    assert seen[0].port == 9000
