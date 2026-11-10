"""Validate only configuration consumed by the current executable."""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, cast

Environment = Literal["development", "test", "production"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


class ConfigurationError(ValueError):
    """Report invalid field names without retaining their potentially secret values."""

    def __init__(self, fields: tuple[str, ...]) -> None:
        self.fields = fields
        super().__init__(f"Invalid configuration fields: {', '.join(fields)}")


@dataclass(frozen=True, slots=True)
class Settings:
    environment: Environment
    log_level: LogLevel

    @classmethod
    def from_environ(cls, environ: Mapping[str, str]) -> "Settings":
        environment = environ.get("APP_ENV", "development")
        log_level = environ.get("LOG_LEVEL", "INFO")
        invalid_fields: list[str] = []
        if environment not in ("development", "test", "production"):
            invalid_fields.append("APP_ENV")
        if log_level not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
            invalid_fields.append("LOG_LEVEL")
        if invalid_fields:
            raise ConfigurationError(tuple(invalid_fields))
        return cls(cast(Environment, environment), cast(LogLevel, log_level))


ThinkingLevel = Literal["default", "low", "medium", "high"]
Endpointing = Literal["standard", "short", "supershort"]

_PROJECT = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]")
_LOCATION = re.compile(r"[a-z][a-z0-9-]{1,30}")
_MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{1,62}")
_VOICE = re.compile(r"[A-Za-z0-9_-]{1,64}")
DEFAULT_REPLY_MODEL = "gemini-3.8-flash"
# Gemini 3.8 Flash rejects "minimal". "default" sends no thinking setting, for models
# such as Flash-Lite that do not think unless asked.
THINKING_LEVELS: tuple[ThinkingLevel, ...] = ("default", "low", "medium", "high")
DEFAULT_THINKING_LEVEL: ThinkingLevel = "low"
_VOICE_FIELDS = {
    "GOOGLE_CLOUD_PROJECT": ("", _PROJECT),
    "SPEECH_LOCATION": ("us", _LOCATION),
    "SPEECH_MODEL": ("chirp_3", _MODEL),
    "GEMINI_LOCATION": ("global", _LOCATION),
    "GEMINI_MODEL": (DEFAULT_REPLY_MODEL, _MODEL),
    "GEMINI_TTS_LOCATION": ("us", _LOCATION),
    "GEMINI_TTS_MODEL": ("gemini-3.8-flash-tts", _MODEL),
    "GEMINI_TTS_VOICE": ("Kore", _VOICE),
}


@dataclass(frozen=True, slots=True)
class VoiceSettings:
    """Settings for the voice check. Credentials come from Google ADC, not from here."""

    project: str
    speech_location: str
    speech_model: str
    speech_endpointing: Endpointing
    gemini_location: str
    gemini_model: str
    thinking_level: ThinkingLevel
    tts_location: str
    tts_model: str
    tts_voice: str

    @classmethod
    def from_environ(cls, environ: Mapping[str, str]) -> "VoiceSettings":
        values = {name: environ.get(name, default) for name, (default, _) in _VOICE_FIELDS.items()}
        invalid = [
            name
            for name, (_, pattern) in _VOICE_FIELDS.items()
            if not pattern.fullmatch(values[name])
        ]
        endpointing = environ.get("SPEECH_ENDPOINTING", "standard")
        if endpointing not in ("standard", "short", "supershort"):
            invalid.append("SPEECH_ENDPOINTING")
        thinking_level = environ.get("GEMINI_THINKING_LEVEL", DEFAULT_THINKING_LEVEL)
        if thinking_level not in THINKING_LEVELS:
            invalid.append("GEMINI_THINKING_LEVEL")
        if invalid:
            raise ConfigurationError(tuple(invalid))
        return cls(
            project=values["GOOGLE_CLOUD_PROJECT"],
            speech_location=values["SPEECH_LOCATION"],
            speech_model=values["SPEECH_MODEL"],
            speech_endpointing=cast(Endpointing, endpointing),
            gemini_location=values["GEMINI_LOCATION"],
            gemini_model=values["GEMINI_MODEL"],
            thinking_level=cast(ThinkingLevel, thinking_level),
            tts_location=values["GEMINI_TTS_LOCATION"],
            tts_model=values["GEMINI_TTS_MODEL"],
            tts_voice=values["GEMINI_TTS_VOICE"],
        )
