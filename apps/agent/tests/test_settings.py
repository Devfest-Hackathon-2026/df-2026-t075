import pytest

from classroom_agent.bootstrap.settings import ConfigurationError, Settings


def test_defaults_do_not_require_external_credentials() -> None:
    settings = Settings.from_environ({})
    assert settings.environment == "development"
    assert settings.log_level == "INFO"


@pytest.mark.parametrize("environment", ["development", "test", "production"])
@pytest.mark.parametrize("log_level", ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"])
def test_supported_settings(environment: str, log_level: str) -> None:
    settings = Settings.from_environ({"APP_ENV": environment, "LOG_LEVEL": log_level})
    assert settings.environment == environment
    assert settings.log_level == log_level


@pytest.mark.parametrize("value", ["", "staging", " INFO ", "secret-value"])
@pytest.mark.parametrize("field", ["APP_ENV", "LOG_LEVEL"])
def test_invalid_settings_report_only_field_names(field: str, value: str) -> None:
    with pytest.raises(ConfigurationError) as raised:
        Settings.from_environ({field: value})
    assert raised.value.fields == (field,)
    assert str(raised.value) == f"Invalid configuration fields: {field}"
    assert repr(raised.value) == f"ConfigurationError('Invalid configuration fields: {field}')"


def test_validation_reports_all_invalid_fields_together() -> None:
    with pytest.raises(ConfigurationError) as raised:
        Settings.from_environ({"APP_ENV": "secret-one", "LOG_LEVEL": "secret-two"})
    assert raised.value.fields == ("APP_ENV", "LOG_LEVEL")
    assert "secret" not in str(raised.value)


def test_unrelated_environment_values_are_not_retained() -> None:
    settings = Settings.from_environ({"GEMINI_API_KEY": "secret-value"})
    assert "secret-value" not in repr(settings)
