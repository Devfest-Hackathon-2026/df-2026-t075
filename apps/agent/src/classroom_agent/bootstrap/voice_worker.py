"""Explicit entry point for the metered worker. Importing this module opens no connections."""

import argparse
import asyncio
import logging
import os
import signal
from contextlib import AsyncExitStack

from livekit.agents import AgentServer, JobContext, JobExecutorType

from classroom_agent.bootstrap.settings import (
    DEFAULT_REPLY_MODEL,
    DEFAULT_THINKING_LEVEL,
    THINKING_LEVELS,
)
from classroom_agent.infrastructure import meeting_voice
from classroom_agent.infrastructure.google_voice import GoogleVoice
from classroom_agent.infrastructure.logging import configure_logging
from classroom_agent.infrastructure.meeting_context import MeetingContext, meeting_origin
from classroom_agent.infrastructure.voice_room import (
    AGENT_NAME,
    accept_probe,
    bounded_job,
    run_probe_room,
)

PROBE_REPLY_MODELS = {DEFAULT_REPLY_MODEL, "gemini-3.5-flash-lite"}


def reply_model(meeting: bool = False) -> str:
    default = "gemini-3.5-flash-lite" if meeting else DEFAULT_REPLY_MODEL
    return os.environ.get("GEMINI_MODEL", default)


def reply_thinking(meeting: bool = False) -> str:
    default = "default" if meeting else DEFAULT_THINKING_LEVEL
    return os.environ.get("GEMINI_THINKING_LEVEL", default)


def open_providers(stack: AsyncExitStack, member_name: str | None = None) -> GoogleVoice:
    providers = GoogleVoice(
        os.environ["GOOGLE_CLOUD_PROJECT"],
        reply_model(member_name is not None),
        reply_thinking(member_name is not None),
        member_name=member_name or "ノト",
    )
    stack.push_async_callback(providers.aclose)
    return providers


async def job(ctx: JobContext) -> None:
    await bounded_job(ctx, lambda: run_probe_room(ctx, open_providers))


async def meeting_job(ctx: JobContext) -> None:
    await meeting_voice.run_meeting_room(ctx, open_providers, MeetingContext)


def probe_load(server: AgentServer) -> float:
    # The SDK also reserves a pending slot before the accepted room becomes active.
    return float(bool(server.active_jobs))


async def serve(meeting: bool = False) -> None:
    server = AgentServer(
        host="127.0.0.1",
        port=0,
        num_idle_processes=0,
        job_executor_type=JobExecutorType.THREAD,
        load_fnc=probe_load,
        load_threshold=1.0,
    )
    server.on(
        "worker_registered",
        lambda *_: logging.getLogger("classroom_agent").info("voice_worker_registered"),
    )
    if meeting:
        server.rtc_session(
            meeting_job,
            agent_name=meeting_voice.AGENT_NAME,
            on_request=meeting_voice.accept_meeting,
        )
    else:
        server.rtc_session(job, agent_name=AGENT_NAME, on_request=accept_probe)
    loop = asyncio.get_running_loop()
    serving = asyncio.create_task(server.run())
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, serving.cancel)
    try:
        await serving
    finally:
        await server.aclose()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)


def main(*, meeting: bool = False) -> int:
    # Dedicated process: provider exception messages and RTC debug logs can contain captions/URLs.
    logging.basicConfig(handlers=[logging.NullHandler()], force=True)
    logger = configure_logging("INFO")
    required: tuple[str, ...] = (
        "LIVEKIT_URL",
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
        "GOOGLE_CLOUD_PROJECT",
    )
    if meeting:
        required += ("MEETING_WEB_ORIGIN", "MEETING_WORKER_AUDIENCE")
    invalid_fields = tuple(key for key in required if not os.environ.get(key))
    if meeting and "MEETING_WEB_ORIGIN" not in invalid_fields:
        try:
            meeting_origin(os.environ["MEETING_WEB_ORIGIN"])
        except ValueError:
            invalid_fields += ("MEETING_WEB_ORIGIN",)
    if reply_model(meeting) not in PROBE_REPLY_MODELS:
        invalid_fields += ("GEMINI_MODEL",)
    if reply_thinking(meeting) not in THINKING_LEVELS:
        invalid_fields += ("GEMINI_THINKING_LEVEL",)
    if invalid_fields:
        logger.error("configuration_invalid", extra={"invalid_fields": invalid_fields})
        return 2
    logger.info("voice_worker_starting")
    try:
        asyncio.run(serve(meeting))
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    except Exception:
        logger.error("voice_worker_failed")
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--meeting", action="store_true")
    raise SystemExit(main(meeting=parser.parse_args().meeting))
