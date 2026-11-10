"""Serve a local page for talking to the AI member through the microphone.

The same Speech-to-Text, Gemini and Gemini TTS adapters as voice-check are used.
Nothing said or replied is written to logs or files; the page shows it on screen only.
"""

import argparse
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TextIO

from websockets.sync.server import Server

from classroom_agent.application.voice_check import LiveSession, LiveTurnResult
from classroom_agent.bootstrap.settings import ConfigurationError, Settings, VoiceSettings
from classroom_agent.bootstrap.voice_check import (
    Adapters,
    describe_models,
    google_adapters,
    prices_for,
)
from classroom_agent.domain.voice_cost import turn_cost
from classroom_agent.infrastructure.live_server import build_server, page_html
from classroom_agent.infrastructure.logging import configure_logging
from classroom_agent.infrastructure.wav_files import AudioFileError, read_wav

HOST = "127.0.0.1"


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--topic", default="次の勉強会で読む本を決める")
    parser.add_argument("--member-name", default="ノト")
    parser.add_argument(
        "--phrase", action="append", default=[], help="Word to recognize more easily"
    )
    parser.add_argument(
        "--sample", type=Path, help="WAV offered on the page as a recorded question"
    )
    parser.add_argument(
        "--patience",
        type=float,
        default=1.0,
        help="Multiply the silence waited before replying (0.5-3); raise it if cut off",
    )


def summarize_for(settings: VoiceSettings) -> Callable[[LiveTurnResult], dict[str, object]]:
    prices = prices_for(settings)

    def summarize(result: LiveTurnResult) -> dict[str, object]:
        cost = turn_cost(result.usage, prices)
        return {
            "replyFirst": round(result.reply_first_wait, 3),
            "replyDone": round(result.reply_wait, 3),
            "firstAudio": round(result.first_audio_wait, 3),
            "costUsd": cost.total if cost else None,
        }

    return summarize


def _serve_until_interrupted(server: Server) -> None:
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()


def run(
    args: argparse.Namespace,
    environ: Mapping[str, str],
    *,
    stdout: TextIO,
    adapters_factory: Callable[[VoiceSettings, tuple[str, ...]], Adapters] = google_adapters,
    start: Callable[[Server], None] = _serve_until_interrupted,
) -> int:
    try:
        base = Settings.from_environ(environ)
        settings = VoiceSettings.from_environ(environ)
    except ConfigurationError as error:
        configure_logging("ERROR").error(
            "configuration_invalid", extra={"invalid_fields": error.fields}
        )
        return 2
    logger = configure_logging(base.log_level)
    if not 1024 <= args.port <= 65535:
        logger.error("live_check_failed", extra={"stage": "input", "reason": "invalid_port"})
        return 2
    if not 0.5 <= args.patience <= 3:
        logger.error("live_check_failed", extra={"stage": "input", "reason": "invalid_patience"})
        return 2

    sample: bytes | None = None
    if args.sample is not None:
        try:
            read_wav(args.sample)
            sample = args.sample.read_bytes()
        except AudioFileError as error:
            logger.error("live_check_failed", extra={"stage": "input", "reason": error.reason})
            return 2

    # Without the hint, "ノト" came back as "のと" on 2026-11-08, so the name is always included.
    phrases = tuple(dict.fromkeys((args.member_name, *args.phrase)))
    adapters = adapters_factory(settings, phrases)

    def session() -> LiveSession:
        return LiveSession(
            topic=args.topic,
            member_name=args.member_name,
            recognizer=adapters.recognizer,
            writer=adapters.writer,
            synthesizer=adapters.synthesizer,
            clock=time.monotonic,
            patience=args.patience,
        )

    page = page_html(
        {
            "memberName": args.member_name,
            "topic": args.topic,
            "models": describe_models(settings),
            "hasSample": sample is not None,
        }
    )
    try:
        server = build_server(
            host=HOST,
            port=args.port,
            page=page,
            sample_wav=sample,
            session_factory=session,
            summarize=summarize_for(settings),
            logger=logger,
        )
    except OSError:
        logger.error("live_check_failed", extra={"stage": "input", "reason": "port_unavailable"})
        return 2
    print(f"ブラウザで http://{HOST}:{args.port}/ を開いてください。終了は Ctrl+C。", file=stdout)
    stdout.flush()
    start(server)
    return 0
