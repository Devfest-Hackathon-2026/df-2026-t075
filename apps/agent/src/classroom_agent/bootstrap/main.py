"""Command entry: the default configuration check, or the voice check."""

import argparse
import os
import sys
from collections.abc import Sequence
from typing import NoReturn

from classroom_agent.bootstrap import live_check, voice_check
from classroom_agent.bootstrap.settings import ConfigurationError, Settings
from classroom_agent.infrastructure.logging import configure_logging


class _ConfigCheckParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # argparse's default error includes the unrecognized argument values.
        self.exit(2, "Invalid command arguments. Use --help for usage.\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = _ConfigCheckParser(
        description=(
            "Validate local configuration and exit. No worker or provider connection starts. "
            "The voice-check and live-check commands call Google services."
        )
    )
    commands = parser.add_subparsers(dest="command")
    voice_check.add_arguments(
        commands.add_parser(
            "voice-check",
            description=(
                "Send one recorded WAV through Speech-to-Text, Gemini and Gemini TTS, "
                "and report the delay, the recognition error rate and the cost."
            ),
        )
    )
    live_check.add_arguments(
        commands.add_parser(
            "live-check",
            description=(
                "Serve a page on 127.0.0.1 to talk to the AI member through the microphone. "
                "Every turn calls Google services and is billed."
            ),
        )
    )
    args = parser.parse_args(argv)
    if args.command == "voice-check":
        return voice_check.run(args, os.environ, stdout=sys.stdout, stderr=sys.stderr)
    if args.command == "live-check":
        return live_check.run(args, os.environ, stdout=sys.stdout)

    try:
        settings = Settings.from_environ(os.environ)
    except ConfigurationError as error:
        logger = configure_logging("ERROR")
        logger.error("configuration_invalid", extra={"invalid_fields": error.fields})
        return 2

    logger = configure_logging(settings.log_level)
    logger.info(
        "configuration_valid",
        extra={"environment": settings.environment, "mode": "config-check"},
    )
    return 0
