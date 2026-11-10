import argparse
import io
import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from voice_samples import speech

from classroom_agent.application.voice_check import (
    VoiceCheckError,
    VoiceTurnRequest,
    VoiceTurnResult,
)
from classroom_agent.bootstrap import main as main_module
from classroom_agent.bootstrap import voice_check
from classroom_agent.bootstrap.settings import ConfigurationError, VoiceSettings
from classroom_agent.domain.voice_check import PcmAudio, TurnTimeline
from classroom_agent.domain.voice_cost import Tokens, TurnUsage
from classroom_agent.infrastructure.wav_files import write_wav

ENVIRON = {"GOOGLE_CLOUD_PROJECT": "demo-project", "APP_ENV": "test"}
TRANSCRIPT = "ノト、次に読む本はどうしよう"
REPLY = "みなさんは、どんな本を読みたいですか？"
Turn = Callable[[VoiceTurnRequest], VoiceTurnResult]


def result(*, stream_closed: bool = False, wait: float = 2.1) -> VoiceTurnResult:
    return VoiceTurnResult(
        transcript=TRANSCRIPT,
        reply=REPLY,
        voice=PcmAudio(bytes(48_000), 24_000),
        timeline=TurnTimeline(
            speech_ended=10.0,
            audio_sent=10.9 if stream_closed else 12.0,
            transcript_final=10.9,
            reply_first_text=11.4,
            reply_done=11.6,
            first_audio=10.0 + wait,
            audio_done=13.0,
        ),
        usage=TurnUsage(4.0, Tokens(300, 60), Tokens(20, 100)),
    )


def turns(*outcomes: VoiceTurnResult | VoiceCheckError) -> Any:
    """A runner factory whose turns return or raise the outcomes in order."""
    queue = list(outcomes)
    built: list[tuple[VoiceSettings, tuple[str, ...]]] = []
    requests: list[VoiceTurnRequest] = []

    def factory(settings: VoiceSettings, phrases: tuple[str, ...]) -> Turn:
        built.append((settings, phrases))

        def turn(request: VoiceTurnRequest) -> VoiceTurnResult:
            requests.append(request)
            outcome = queue.pop(0)
            if isinstance(outcome, VoiceCheckError):
                raise outcome
            return outcome

        return turn

    factory.built = built  # type: ignore[attr-defined]
    factory.requests = requests  # type: ignore[attr-defined]
    return factory


def parse(tmp_path: Path, *extra: str) -> argparse.Namespace:
    audio = tmp_path / "input.wav"
    write_wav(audio, speech())
    parser = argparse.ArgumentParser()
    voice_check.add_arguments(parser)
    return parser.parse_args(["--audio", str(audio), "--out-dir", str(tmp_path / "out"), *extra])


def run(
    args: argparse.Namespace, factory: Any, environ: dict[str, str] | None = None
) -> tuple[int, str, str]:
    stdout, stderr = io.StringIO(), io.StringIO()
    code = voice_check.run(
        args, environ or ENVIRON, stdout=stdout, stderr=stderr, runner_factory=factory
    )
    return code, stdout.getvalue(), stderr.getvalue()


def test_success_prints_numbers_only_and_saves_the_texts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = turns(result())
    args = parse(tmp_path, "--reference", "ノト、次に読む本はどうしよう？", "--phrase", "ノト")
    code, out, err = run(args, factory)

    assert code == 0
    assert err == ""
    assert capsys.readouterr().out == ""
    assert "AIが話し始めるまで      2.10秒" in out
    assert "誤り率（CER）  0.0%" in out
    assert "1分あたりの見込み" in out
    assert "回目" not in out
    assert TRANSCRIPT not in out and REPLY not in out

    [(settings, phrases)] = factory.built
    assert settings.project == "demo-project"
    assert phrases == ("ノト",)
    [request] = factory.requests
    assert request.member_name == "ノト"
    assert request.audio.sample_rate == 16_000

    [run_dir] = (tmp_path / "out").iterdir()
    report = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
    assert report["text"]["transcript"] == TRANSCRIPT
    assert report["seconds"]["transcript_wait"] == 0.9
    assert report["models"]["reply"] == "global/gemini-3.8-flash"
    assert report["models"]["endpointing"] == "standard"
    assert report["cost"]["assumptions"]["participants"] == 3
    assert report["cost"]["meeting_minute_usd"]["speech"] == pytest.approx(0.048)
    assert (run_dir / "reply.wav").stat().st_size > 48_000


def test_repeats_reuse_one_runner_and_report_the_median(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = turns(
        result(wait=3.0), VoiceCheckError("reply", "ReadTimeout"), result(wait=5.0), result()
    )
    code, out, err = run(parse(tmp_path, "--repeat", "4"), factory)

    assert code == 1
    assert len(factory.built) == 1
    assert len(factory.requests) == 4
    assert "── 2回目 ──" in out
    assert "中央値 ── AIが話し始めるまで 3.00秒（成功 3/4回、最短 2.10秒・最長 5.00秒）" in out
    assert "30秒以内" in err
    assert json.loads(capsys.readouterr().out)["reason"] == "ReadTimeout"
    [run_dir] = (tmp_path / "out").iterdir()
    assert sorted(path.name for path in run_dir.iterdir()) == ["run-1", "run-3", "run-4"]


def test_missing_tts_usage_keeps_measurements_but_omits_cost(tmp_path: Path) -> None:
    measured = replace(result(), usage=TurnUsage(4.0, Tokens(300, 60, thoughts=40), None))
    code, out, _ = run(parse(tmp_path), turns(measured))
    assert code == 0 and "未算出" in out
    [path] = (tmp_path / "out").glob("*/report.json")
    report = json.loads(path.read_text())
    assert report["cost"] is None
    assert report["usage"]["reply_input_tokens"] == 300
    assert report["usage"]["reply_thought_tokens"] == 40
    assert report["usage"]["voice_input_tokens"] is None


def test_unknown_model_prices_are_not_guessed(tmp_path: Path) -> None:
    environ = {**ENVIRON, "GEMINI_TTS_MODEL": "some-new-tts"}
    code, out, _ = run(parse(tmp_path), turns(result(stream_closed=True)), environ)
    assert code == 0
    assert "料金が未登録" in out
    assert "誤り率" not in out
    assert "注意: 文字起こしが音声を送り終えた後" in out


@pytest.mark.parametrize(
    ("environ", "input_price"),
    [
        ({"GEMINI_LOCATION": "us-central1"}, 0.825),
        ({"GEMINI_MODEL": "gemini-3.5-flash-lite"}, 0.30),
    ],
)
def test_prices_follow_the_model_and_location(environ: dict[str, str], input_price: float) -> None:
    prices = voice_check.prices_for(VoiceSettings.from_environ({**ENVIRON, **environ}))
    assert prices is not None
    assert prices.reply_input_per_million == input_price


def test_missing_project_is_reported_by_name_only(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, err = run(parse(tmp_path), None, {"GEMINI_TTS_VOICE": "secret value!"})
    assert code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["invalid_fields"] == ["GOOGLE_CLOUD_PROJECT", "GEMINI_TTS_VOICE"]
    assert "secret" not in out + err


@pytest.mark.parametrize(
    ("extra", "reason"),
    [
        (("--participants", "0"), "invalid_estimate"),
        (("--repeat", "0"), "invalid_repeat"),
        (("--repeat", "11"), "invalid_repeat"),
        (("--reference", "  "), "empty_reference"),
    ],
)
def test_invalid_options_stop_before_any_call(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], extra: tuple[str, ...], reason: str
) -> None:
    code, *_ = run(parse(tmp_path, *extra), None)
    assert code == 2
    assert json.loads(capsys.readouterr().out)["reason"] == reason


def test_unreadable_audio_is_reported_without_the_path(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    args = parse(tmp_path)
    args.audio = tmp_path / "secret-name.wav"
    code, *_ = run(args, None)
    output = capsys.readouterr().out
    assert code == 2
    assert json.loads(output)["reason"] == "audio_file_not_found"
    assert "secret-name" not in output


class ApiError(Exception):
    def __init__(self, code: int) -> None:
        super().__init__("Permission denied on project demo-project with details")
        self.code = code


def failure(stage: Any, reason: str, cause: BaseException | None = None) -> VoiceCheckError:
    error = VoiceCheckError(stage, reason)
    error.__cause__ = cause
    return error


def test_provider_errors_log_stage_and_status_with_a_hint(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = turns(failure("reply", "ApiError", ApiError(403)))
    code, _, err = run(parse(tmp_path), factory)
    output = capsys.readouterr().out
    payload = json.loads(output)
    assert code == 1
    assert (payload["stage"], payload["reason"], payload["status_code"]) == (
        "reply",
        "ApiError",
        403,
    )
    assert "Permission denied" not in output + err
    assert "APIの有効化と権限" in err
    assert not (tmp_path / "out").exists()


def test_missing_credentials_get_a_login_hint(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = turns(failure("speech", "DefaultCredentialsError", RuntimeError("no adc")))
    code, _, err = run(parse(tmp_path), factory)
    assert code == 1
    assert json.loads(capsys.readouterr().out)["status_code"] is None
    assert "gcloud auth application-default login" in err


def test_errors_without_a_known_hint_print_nothing_extra(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, _, err = run(parse(tmp_path), turns(failure("voice", "Unexpected")))
    capsys.readouterr()
    assert code == 1
    assert err == ""


def test_google_turns_build_the_adapters_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run(request: VoiceTurnRequest, **kwargs: Any) -> str:
        calls.append({**kwargs, "request": request})
        return "result"

    monkeypatch.setattr(voice_check, "run_voice_turn", fake_run)
    settings = VoiceSettings.from_environ({**ENVIRON, "SPEECH_ENDPOINTING": "short"})
    turn = voice_check.google_turns(settings, ("ノト",))
    request = VoiceTurnRequest(speech(), "お題", "ノト")
    assert turn(request) == "result"  # type: ignore[comparison-overlap]
    assert turn(request) == "result"  # type: ignore[comparison-overlap]

    first, second = calls
    assert first["request"] is request
    assert first["recognizer"] is second["recognizer"]
    assert first["writer"] is second["writer"]
    assert first["synthesizer"].sample_rate == 24_000
    assert first["recognizer"]._phrases == ("ノト",)
    assert first["writer"]._model == "gemini-3.8-flash"


def test_main_dispatches_the_voice_check(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[argparse.Namespace] = []

    def fake_run(args: argparse.Namespace, *_: Any, **__: Any) -> int:
        seen.append(args)
        return 7

    monkeypatch.setattr(voice_check, "run", fake_run)
    assert main_module.main(["voice-check", "--audio", "input.wav"]) == 7
    assert seen[0].audio == Path("input.wav")


def test_voice_settings_defaults_and_validation() -> None:
    settings = VoiceSettings.from_environ({"GOOGLE_CLOUD_PROJECT": "demo-project"})
    assert (settings.speech_location, settings.speech_model) == ("us", "chirp_3")
    assert settings.speech_endpointing == "standard"
    assert (settings.gemini_location, settings.gemini_model) == ("global", "gemini-3.8-flash")
    assert settings.thinking_level == "low"
    assert (settings.tts_location, settings.tts_model, settings.tts_voice) == (
        "us",
        "gemini-3.8-flash-tts",
        "Kore",
    )
    with pytest.raises(ConfigurationError) as raised:
        VoiceSettings.from_environ(
            {
                "GOOGLE_CLOUD_PROJECT": "demo-project",
                "GEMINI_THINKING_LEVEL": "minimal",
                "SPEECH_ENDPOINTING": "instant",
            }
        )
    assert raised.value.fields == ("SPEECH_ENDPOINTING", "GEMINI_THINKING_LEVEL")
