import json
import os
import subprocess
import sys

import pytest

from classroom_agent.bootstrap.main import main


def test_config_check_succeeds_and_reports_its_limited_scope(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("LOG_LEVEL", "INFO")
    assert main([]) == 0
    output = capsys.readouterr()
    payload = json.loads(output.out)
    assert payload["event"] == "configuration_valid"
    assert payload["mode"] == "config-check"
    assert payload["environment"] == "test"
    assert output.err == ""


def test_config_check_fails_without_exposing_environment_values(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("APP_ENV", "secret-one")
    monkeypatch.setenv("LOG_LEVEL", "secret-two")
    assert main([]) == 2
    output = capsys.readouterr()
    payload = json.loads(output.out)
    assert payload["event"] == "configuration_invalid"
    assert payload["invalid_fields"] == ["APP_ENV", "LOG_LEVEL"]
    assert "secret" not in output.out + output.err


@pytest.mark.parametrize(("environment", "expected_code"), [("test", 0), ("invalid", 2)])
def test_module_entrypoint_exits_promptly(environment: str, expected_code: int) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "classroom_agent"],
        env={**os.environ, "APP_ENV": environment, "LOG_LEVEL": "INFO"},
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == expected_code
    assert len(result.stdout.splitlines()) == 1
    assert result.stderr == ""


def test_help_describes_the_configuration_check(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        main(["--help"])
    assert raised.value.code == 0
    output = " ".join(capsys.readouterr().out.split())
    assert "No worker or provider connection starts" in output


def test_unknown_operation_is_rejected(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        main(["start", "secret-argument"])
    assert raised.value.code == 2
    assert capsys.readouterr().err == "Invalid command arguments. Use --help for usage.\n"
