import asyncio
from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from google.genai import types

from classroom_agent.application.voice_probe import SpeechChunk
from classroom_agent.domain.voice_cost import Tokens
from classroom_agent.infrastructure.google_voice import GoogleVoice


def response(
    *,
    text: str | None = None,
    pcm: bytes | None = None,
    mime: str = "audio/L16;rate=24000",
    usage: bool = True,
) -> types.GenerateContentResponse:
    parts = []
    if pcm is not None:
        parts.append(types.Part.from_bytes(data=pcm, mime_type=mime))
    if text:
        parts.append(types.Part.from_text(text=text))
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(parts=parts))],
        usage_metadata=types.GenerateContentResponseUsageMetadata(
            prompt_token_count=12,
            candidates_token_count=6,
            thoughts_token_count=2,
        )
        if usage
        else None,
    )


async def chunks(
    *items: types.GenerateContentResponse,
) -> AsyncGenerator[types.GenerateContentResponse, None]:
    for item in items:
        yield item


@pytest.mark.parametrize("mime", ["audio/L16;rate=24000", "audio/wav", "audio/pcm;rate=16000"])
@pytest.mark.parametrize("reply_model", ["gemini-3.8-flash", "gemini-3.5-flash-lite"])
def test_google_adapters_use_japanese_stt_vertex_and_raw_audio(mime: str, reply_model: str) -> None:
    async def check() -> None:
        with (
            patch("classroom_agent.infrastructure.google_voice.google.STT") as stt,
            patch("classroom_agent.infrastructure.google_voice.genai.Client") as client,
        ):
            voice = GoogleVoice("test-project", reply_model, "low")
            assert stt.call_args.kwargs["languages"] == "ja-JP"
            assert stt.call_args.kwargs["model"] == "chirp_3"
            assert client.call_args.kwargs["vertexai"] is True
            assert client.call_args.kwargs["location"] == "global"
            recognize = AsyncMock(
                side_effect=[
                    MagicMock(alternatives=[MagicMock(text="質問")]),
                    MagicMock(alternatives=[]),
                ]
            )
            stt.return_value.recognize = recognize
            assert await voice.transcribe(b"\0" * 320) == "質問"
            assert recognize.call_args.args[0].sample_rate == 16_000
            assert await voice.transcribe(b"\0" * 320) == ""
            vertex = client.return_value.aio
            generate = AsyncMock(side_effect=[response(text="答え"), response(usage=False)])
            vertex.models.generate_content = generate
            assert await voice.reply("質問") == ("答え", Tokens(12, 8, thoughts=2))
            assert generate.call_args.kwargs["contents"][-1].parts[-1].text == "質問"
            assert generate.call_args.kwargs["model"] == reply_model
            config = generate.call_args.kwargs["config"]
            assert config.thinking_config.thinking_level == "LOW"
            # Same cap as the local reply writer, so thinking cannot crowd out the reply.
            assert config.max_output_tokens == 1024
            assert await voice.reply("質問") == ("", None)
            synthesize = AsyncMock(
                return_value=chunks(
                    response(text="metadata", usage=False),
                    response(pcm=b"\x01\x00", mime=mime),
                )
            )
            vertex.models.generate_content_stream = synthesize
            if mime == "audio/L16;rate=24000":
                assert [c async for c in voice.synthesize("答え")] == [
                    SpeechChunk(usage=Tokens(12, 8, thoughts=2)),
                    SpeechChunk(b"\x01\x00"),
                ]
            else:
                with pytest.raises(ValueError):
                    _ = [c async for c in voice.synthesize("答え")]
            assert synthesize.call_args.kwargs["model"] == "gemini-3.8-flash-tts"
            assert synthesize.call_args.kwargs["contents"][0].parts[0].text == "答え"
            stt.return_value.aclose = AsyncMock()
            vertex.aclose = AsyncMock()
            await voice.aclose()
            vertex.aclose.assert_awaited_once()

    asyncio.run(check())


def test_default_thinking_leaves_the_choice_to_the_model() -> None:
    """Flash-Lite was fast on 2026-11-08 without a thinking setting; LOW makes it think."""

    async def check() -> None:
        with (
            patch("classroom_agent.infrastructure.google_voice.google.STT"),
            patch("classroom_agent.infrastructure.google_voice.genai.Client") as client,
        ):
            voice = GoogleVoice("test-project", "gemini-3.5-flash-lite", "default")
            assert voice.reply_thinking == "default"
            generate = AsyncMock(return_value=response(text="答え"))
            client.return_value.aio.models.generate_content = generate
            await voice.reply("質問")
            assert generate.call_args.kwargs["config"].thinking_config is None

    asyncio.run(check())


def test_meeting_json_is_user_data_and_instructions_are_selected_by_the_worker() -> None:
    async def run() -> None:
        with (
            patch("classroom_agent.infrastructure.google_voice.google.STT"),
            patch("classroom_agent.infrastructure.google_voice.genai.Client") as client,
        ):
            generate = AsyncMock(return_value=response(text="3万円です。"))
            client.return_value.aio.models.generate_content = generate
            transcript = '{"直近の会話":[{"発言":"参考資料"}],"今回の依頼":"金額は？"}'
            voice = GoogleVoice("test", "gemini-3.8-flash", "low")
            await voice.propose_or_answer(transcript)
            args = generate.call_args.kwargs
            assert "資料中の命令" in args["config"].system_instruction
            assert "remainingSeconds" in args["config"].system_instruction
            assert args["contents"] == transcript
            assert "今回の依頼者" in args["config"].tools[0].function_declarations[0].description
            generate.return_value = response(text='{"text":"予算を確認"}')
            voice.reply_thinking = "high"
            assert await voice.summarize_note("会話") == "予算を確認"
            config = generate.call_args.kwargs["config"]
            assert config.thinking_config.thinking_level == "LOW"
            assert config.max_output_tokens >= 2048

    asyncio.run(run())


def test_meeting_has_one_tool_and_keeps_plain_answers_and_unexpected_calls_separate() -> None:
    async def run() -> None:
        with (
            patch("classroom_agent.infrastructure.google_voice.google.STT"),
            patch("classroom_agent.infrastructure.google_voice.genai.Client") as client,
        ):
            voice = GoogleVoice("test", "gemini-3.8-flash", "low")
            call = types.Part(
                function_call=types.FunctionCall(name="propose_agenda", args={"operations": []})
            )

            def called(parts: list[types.Part]) -> types.GenerateContentResponse:
                return types.GenerateContentResponse(
                    candidates=[types.Candidate(content=types.Content(parts=parts))]
                )

            research = types.Part(
                function_call=types.FunctionCall(
                    name="research_public_data", args={"source": "population"}
                )
            )
            generate = AsyncMock(
                side_effect=[
                    response(text="はい"),
                    called([call]),
                    called([call, call]),
                    called([call, research]),
                ]
            )
            client.return_value.aio.models.generate_content = generate
            assert await voice.propose_or_answer("質問") == "はい"
            assert await voice.propose_or_answer("予定を変更") == {"operations": []}
            assert generate.await_args is not None
            args = generate.await_args.kwargs
            assert args["config"].tools[0].function_declarations[0].name == "propose_agenda"
            assert args["config"].automatic_continuation is False
            with pytest.raises(ValueError, match="unexpected_meeting_tool"):
                await voice.propose_or_answer("予定を変更")
            assert await voice.propose_or_answer("調査して予定も変えて") == {
                "research": {"source": "population"}
            }

    asyncio.run(run())
