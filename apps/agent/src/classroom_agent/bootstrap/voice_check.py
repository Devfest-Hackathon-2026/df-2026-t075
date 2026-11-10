"""Measure one voice turn against the real Google services.

Only numbers go to the terminal. The transcript, the reply and the AI voice are
saved under the output directory (ignored by Git) so they never reach logs.
"""

import argparse
import json
import statistics
import time
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import TextIO

from classroom_agent.application.voice_check import (
    ReplyWriter,
    SpeechRecognizer,
    SpeechSynthesizer,
    VoiceCheckError,
    VoiceTurnRequest,
    VoiceTurnResult,
    run_voice_turn,
)
from classroom_agent.bootstrap.settings import ConfigurationError, Settings, VoiceSettings
from classroom_agent.domain.voice_check import character_error_rate
from classroom_agent.domain.voice_cost import (
    Prices,
    meeting_minute_cost,
    prices_for_models,
    turn_cost,
)
from classroom_agent.infrastructure.logging import configure_logging
from classroom_agent.infrastructure.wav_files import AudioFileError, read_wav, write_wav

HINTS = {
    "DefaultCredentialsError": (
        "Googleの認証情報が見つかりません。"
        "gcloud auth application-default login を実行してください。"
    ),
    "audio_too_long": "60秒以内の音声にしてください。",
    "no_speech_in_audio": "音声ファイルに声が見つかりません。",
    "empty_transcript": "文字起こしが空でした。日本語の声が入っているか、音量を確かめてください。",
    "empty_reply": "Geminiの返答が空でした。もう一度試してください。",
    "empty_audio": "TTSの音声が空でした。GEMINI_TTS_VOICE を確かめてください。",
    "ReadTimeout": "Geminiが30秒以内に応えませんでした。時間をおいてやり直してください。",
    "DeadlineExceeded": "Speech-to-Textが時間内に応えませんでした。",
}
STATUS_HINTS = {
    400: "設定値（モデル名・思考レベル・声の名前・場所）を確かめてください。",
    403: "APIの有効化と権限を確かめてください（Vertex AI API、Speech-to-Text API）。",
    404: "モデル名と場所（location）の組み合わせを確かめてください。",
    429: "割り当てを超えました。少し待ってからやり直してください。",
}


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--audio", type=Path, required=True, help="16-bit PCM WAV, 60 s or less")
    parser.add_argument("--reference", help="What was actually said, to compute the error rate")
    parser.add_argument("--topic", default="次の勉強会で読む本を決める")
    parser.add_argument("--member-name", default="ノト")
    parser.add_argument(
        "--phrase", action="append", default=[], help="Word to recognize more easily"
    )
    parser.add_argument("--participants", type=int, default=3)
    parser.add_argument("--ai-turns-per-minute", type=float, default=1.0)
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="Run the same recording 1-10 times with reused connections",
    )
    parser.add_argument("--out-dir", type=Path, default=Path("tmp/voice-check"))


def prices_for(settings: VoiceSettings) -> Prices | None:
    return prices_for_models(
        speech_model=settings.speech_model,
        reply_model=settings.gemini_model,
        reply_location=settings.gemini_location,
        tts_model=settings.tts_model,
    )


TurnRunner = Callable[[VoiceTurnRequest], VoiceTurnResult]
RunnerFactory = Callable[[VoiceSettings, tuple[str, ...]], TurnRunner]


@dataclass(frozen=True, slots=True)
class Adapters:
    recognizer: SpeechRecognizer
    writer: ReplyWriter
    synthesizer: SpeechSynthesizer


def google_adapters(settings: VoiceSettings, phrases: tuple[str, ...]) -> Adapters:
    """Build the Google adapters; they connect on first use and then reuse the connection."""
    # Imported here so that the default configuration check does not load the SDKs.
    from classroom_agent.infrastructure.gemini import (
        GeminiReplyWriter,
        GeminiSpeechSynthesizer,
        vertex_client_factory,
    )
    from classroom_agent.infrastructure.google_speech import CloudSpeechRecognizer

    clients = vertex_client_factory(settings.project)
    return Adapters(
        recognizer=CloudSpeechRecognizer(
            project=settings.project,
            location=settings.speech_location,
            model=settings.speech_model,
            endpointing=settings.speech_endpointing,
            phrases=phrases,
        ),
        writer=GeminiReplyWriter(
            client_factory=clients,
            location=settings.gemini_location,
            model=settings.gemini_model,
            thinking_level=settings.thinking_level,
        ),
        synthesizer=GeminiSpeechSynthesizer(
            client_factory=clients,
            location=settings.tts_location,
            model=settings.tts_model,
            voice=settings.tts_voice,
        ),
    )


def describe_models(settings: VoiceSettings) -> str:
    return (
        f"文字起こし {settings.speech_location}/{settings.speech_model}"
        f"（区切り {settings.speech_endpointing}）・"
        f"返答 {settings.gemini_location}/{settings.gemini_model}"
        f"（思考 {settings.thinking_level}）・"
        f"声 {settings.tts_location}/{settings.tts_model}/{settings.tts_voice}"
    )


def google_turns(settings: VoiceSettings, phrases: tuple[str, ...]) -> TurnRunner:
    """Build the adapters once, so repeated turns reuse connections as a running worker would."""
    adapters = google_adapters(settings, phrases)
    recognizer, writer, synthesizer = adapters.recognizer, adapters.writer, adapters.synthesizer

    def turn(request: VoiceTurnRequest) -> VoiceTurnResult:
        return run_voice_turn(
            request,
            recognizer=recognizer,
            writer=writer,
            synthesizer=synthesizer,
            clock=time.monotonic,
            sleep=time.sleep,
        )

    return turn


def _seconds(value: float) -> float:
    return round(value, 3)


def build_report(
    result: VoiceTurnResult,
    settings: VoiceSettings,
    *,
    reference: str | None,
    participants: int,
    ai_turns_per_minute: float,
) -> dict[str, object]:
    timeline = result.timeline
    prices = prices_for(settings)
    cost: dict[str, object] | None = None
    one_turn = turn_cost(result.usage, prices)
    if one_turn is not None and prices is not None:
        minute = meeting_minute_cost(
            one_turn, prices, participants=participants, ai_turns_per_minute=ai_turns_per_minute
        )
        cost = {
            "turn_usd": {
                "speech": one_turn.speech,
                "reply": one_turn.reply,
                "voice": one_turn.voice,
                "total": one_turn.total,
            },
            "meeting_minute_usd": {
                "speech": minute.speech,
                "ai_turns": minute.ai_turns,
                "total": minute.total,
            },
            "assumptions": {
                "participants": participants,
                "ai_turns_per_minute": ai_turns_per_minute,
                "prices": asdict(prices),
            },
        }
    return {
        "models": {
            "speech": f"{settings.speech_location}/{settings.speech_model}",
            "endpointing": settings.speech_endpointing,
            "reply": f"{settings.gemini_location}/{settings.gemini_model}",
            "thinking_level": settings.thinking_level,
            "voice": f"{settings.tts_location}/{settings.tts_model}/{settings.tts_voice}",
        },
        "seconds": {
            "until_ai_speaks": _seconds(timeline.until_ai_speaks),
            "until_caption": _seconds(timeline.until_caption),
            "transcript_wait": _seconds(timeline.transcript_wait),
            "reply_first_text": _seconds(timeline.reply_first_wait),
            "reply_done": _seconds(timeline.reply_wait),
            "first_audio_after_reply": _seconds(timeline.first_audio_wait),
            "voice_length": _seconds(result.voice.seconds),
        },
        "transcript_needed_stream_close": timeline.transcript_needed_stream_close,
        "character_error_rate": (
            None if reference is None else character_error_rate(reference, result.transcript)
        ),
        "usage": {
            "speech_billed_seconds": result.usage.speech_billed_seconds,
            "reply_input_tokens": result.usage.reply.prompt if result.usage.reply else None,
            "reply_cached_tokens": result.usage.reply.cached if result.usage.reply else None,
            "reply_output_tokens": result.usage.reply.output if result.usage.reply else None,
            "reply_thought_tokens": result.usage.reply.thoughts if result.usage.reply else None,
            "voice_input_tokens": result.usage.voice.prompt if result.usage.voice else None,
            "voice_output_tokens": result.usage.voice.output if result.usage.voice else None,
        },
        "cost": cost,
        "text": {"reference": reference, "transcript": result.transcript, "reply": result.reply},
    }


def _summary(report: dict[str, object], out_dir: Path) -> str:
    seconds = report["seconds"]
    assert isinstance(seconds, dict)
    lines = [
        f"AIが話し始めるまで      {seconds['until_ai_speaks']:.2f}秒"
        f"（字幕を出せるまで {seconds['until_caption']:.2f}秒）",
        f"  文字起こしの確定待ち  {seconds['transcript_wait']:.2f}秒",
        f"  Geminiの最初の文字    {seconds['reply_first_text']:.2f}秒"
        f" / 返答の完成 {seconds['reply_done']:.2f}秒",
        f"  TTSの最初の音         {seconds['first_audio_after_reply']:.2f}秒",
    ]
    rate = report["character_error_rate"]
    if isinstance(rate, float):
        lines.append(f"聞き取りの誤り率（CER）  {rate:.1%}")
    cost = report["cost"]
    if isinstance(cost, dict):
        turn = cost["turn_usd"]
        minute = cost["meeting_minute_usd"]
        assumptions = cost["assumptions"]
        assert isinstance(turn, dict) and isinstance(minute, dict)
        assert isinstance(assumptions, dict)
        lines.append(
            f"費用（この1回）         ${turn['total']:.4f}"
            f"（文字起こし ${turn['speech']:.4f} / Gemini ${turn['reply']:.4f}"
            f" / 声 ${turn['voice']:.4f}）"
        )
        lines.append(
            f"1分あたりの見込み       ${minute['total']:.4f}"
            f"（{assumptions['participants']}人の文字起こし ${minute['speech']:.4f}"
            f" + AIの発話 {assumptions['ai_turns_per_minute']}回/分 ${minute['ai_turns']:.4f}）"
        )
    else:
        lines.append("費用                    未算出（使用量が未取得、または料金が未登録）")
    if report["transcript_needed_stream_close"]:
        lines.append(
            "注意: 文字起こしが音声を送り終えた後に確定しました。待ち時間は大きめに出ています。"
        )
    lines.append(f"結果: {out_dir / 'report.json'}、AIの声: {out_dir / 'reply.wav'}")
    return "\n".join(lines)


def _status_code(error: BaseException) -> int | None:
    code = getattr(error.__cause__, "code", None)
    return code if isinstance(code, int) else None


def run(
    args: argparse.Namespace,
    environ: Mapping[str, str],
    *,
    stdout: TextIO,
    stderr: TextIO,
    runner_factory: RunnerFactory = google_turns,
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
    if args.participants < 1 or args.ai_turns_per_minute < 0:
        logger.error("voice_check_failed", extra={"stage": "input", "reason": "invalid_estimate"})
        return 2
    if not 1 <= args.repeat <= 10:
        logger.error("voice_check_failed", extra={"stage": "input", "reason": "invalid_repeat"})
        return 2
    if args.reference is not None and not args.reference.strip():
        logger.error("voice_check_failed", extra={"stage": "input", "reason": "empty_reference"})
        return 2
    try:
        audio = read_wav(args.audio)
    except AudioFileError as error:
        logger.error("voice_check_failed", extra={"stage": "input", "reason": error.reason})
        return 2

    request = VoiceTurnRequest(audio=audio, topic=args.topic, member_name=args.member_name)
    turn = runner_factory(settings, tuple(args.phrase))
    base_dir: Path = args.out_dir / datetime.now().strftime("%Y%m%d-%H%M%S")
    waits: list[float] = []
    for index in range(1, args.repeat + 1):
        if args.repeat > 1:
            print(f"── {index}回目 ──", file=stdout)
        try:
            result = turn(request)
        except VoiceCheckError as error:
            status = _status_code(error)
            logger.error(
                "voice_check_failed",
                extra={"stage": error.stage, "reason": error.reason, "status_code": status},
            )
            hint = HINTS.get(error.reason) or (STATUS_HINTS.get(status) if status else None)
            if hint:
                print(hint, file=stderr)
            continue

        report = build_report(
            result,
            settings,
            reference=args.reference,
            participants=args.participants,
            ai_turns_per_minute=args.ai_turns_per_minute,
        )
        out_dir = base_dir if args.repeat == 1 else base_dir / f"run-{index}"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        write_wav(out_dir / "reply.wav", result.voice)
        waits.append(result.timeline.until_ai_speaks)
        print(_summary(report, out_dir), file=stdout)

    if args.repeat > 1 and waits:
        print(
            f"── 中央値 ── AIが話し始めるまで {statistics.median(waits):.2f}秒"
            f"（成功 {len(waits)}/{args.repeat}回、"
            f"最短 {min(waits):.2f}秒・最長 {max(waits):.2f}秒）",
            file=stdout,
        )
    return 0 if len(waits) == args.repeat else 1
