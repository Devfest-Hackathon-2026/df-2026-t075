import io
import wave
from collections.abc import Iterator
from typing import Any, cast

import pytest
from google import genai
from google.genai import types

from classroom_agent.application.voice_check import Exchange, ReplyChunk, ReplyPrompt, VoiceChunk
from classroom_agent.domain.voice_cost import Tokens
from classroom_agent.infrastructure import gemini
from classroom_agent.infrastructure.gemini import (
    GeminiReplyWriter,
    GeminiSpeechSynthesizer,
    vertex_client_factory,
)


class FakeModels:
    def __init__(self, responses: list[types.GenerateContentResponse]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    def generate_content_stream(self, **kwargs: Any) -> Iterator[types.GenerateContentResponse]:
        self.calls.append(kwargs)
        yield from self.responses


class FakeClient:
    def __init__(self, responses: list[types.GenerateContentResponse]) -> None:
        self.models = FakeModels(responses)


def factory(client: FakeClient, locations: list[str]) -> gemini.ClientFactory:
    def create(location: str) -> genai.Client:
        locations.append(location)
        return cast(genai.Client, client)

    return create


def text_response(
    text: str | None, usage: types.GenerateContentResponseUsageMetadata | None = None
) -> types.GenerateContentResponse:
    parts = [] if text is None else [types.Part(text=text)]
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=parts))],
        usage_metadata=usage,
    )


def audio_response(
    blobs: list[types.Blob], usage: types.GenerateContentResponseUsageMetadata | None = None
) -> types.GenerateContentResponse:
    return types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                content=types.Content(
                    role="model", parts=[types.Part(inline_data=blob) for blob in blobs]
                )
            ),
            types.Candidate(content=None),
        ],
        usage_metadata=usage,
    )


def wav_bytes(rate: int, channels: int = 1, frames: bytes = b"\x05\x00") -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(frames * channels)
    return buffer.getvalue()


def test_reply_writer_streams_text_and_counts_thinking_as_output() -> None:
    client = FakeClient(
        [
            text_response("どの本"),
            text_response(None),
            text_response(
                "が気になりますか？",
                types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=100, candidates_token_count=20, thoughts_token_count=30
                ),
            ),
        ]
    )
    locations: list[str] = []
    writer = GeminiReplyWriter(
        client_factory=factory(client, locations),
        location="global",
        model="gemini-3.8-flash",
        thinking_level="low",
    )
    chunks = list(
        writer.write(
            ReplyPrompt(
                "ルール",
                "どう思う？",
                (Exchange("participant", "前の問い"), Exchange("ai", "前の返答")),
                "お題",
            )
        )
    )

    assert chunks == [
        ReplyChunk("どの本"),
        ReplyChunk(""),
        ReplyChunk("が気になりますか？", Tokens(100, 50, thoughts=30)),
    ]
    assert locations == ["global"]
    call = client.models.calls[0]
    assert call["model"] == "gemini-3.8-flash"
    assert [(m.role, [p.text for p in m.parts]) for m in call["contents"]] == [
        ("user", ["前の問い"]),
        ("model", ["前の返答"]),
        ("user", ["お題", "どう思う？"]),
    ]
    config = call["config"]
    assert config.system_instruction == "ルール"
    assert config.thinking_config.thinking_level == types.ThinkingLevel.LOW
    assert config.max_output_tokens == 1024


def test_usage_without_counts_is_unknown() -> None:
    client = FakeClient([text_response("はい", types.GenerateContentResponseUsageMetadata())])
    writer = GeminiReplyWriter(
        client_factory=factory(client, []),
        location="global",
        model="gemini-3.8-flash",
        thinking_level="high",
    )
    assert list(writer.write(ReplyPrompt("s", "u"))) == [ReplyChunk("はい")]


def test_synthesizer_collects_pcm_from_raw_and_wav_parts() -> None:
    client = FakeClient(
        [
            audio_response(
                [types.Blob(data=b"\x01\x00", mime_type="audio/L16;codec=pcm;rate=24000")]
            ),
            audio_response(
                [types.Blob(data=wav_bytes(24_000), mime_type="audio/wav"), types.Blob(data=None)],
                types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=12, candidates_token_count=75
                ),
            ),
            types.GenerateContentResponse(candidates=None),
        ]
    )
    locations: list[str] = []
    synthesizer = GeminiSpeechSynthesizer(
        client_factory=factory(client, locations),
        location="us",
        model="gemini-3.8-flash-tts",
        voice="Kore",
    )
    chunks = list(synthesizer.synthesize("こんにちは", "やさしく"))

    assert chunks == [
        VoiceChunk(b"\x01\x00"),
        VoiceChunk(b"\x05\x00", Tokens(12, 75)),
        VoiceChunk(b""),
    ]
    assert synthesizer.sample_rate == 24_000
    assert locations == ["us"]
    call = client.models.calls[0]
    assert call["model"] == "gemini-3.8-flash-tts"
    part = call["contents"][0].parts[0]
    assert (part.text, part.speech_metadata.style) == ("こんにちは", "やさしく")
    config = call["config"]
    assert config.response_modalities == ["AUDIO"]
    assert config.speech_config.voice_config.voice == "Kore"


@pytest.mark.parametrize(
    "blob",
    [
        types.Blob(data=b"\x01\x00", mime_type="audio/L16;rate=16000"),
        types.Blob(data=wav_bytes(16_000), mime_type="audio/wav"),
        types.Blob(data=wav_bytes(24_000, channels=2), mime_type="audio/wav"),
    ],
)
def test_synthesizer_rejects_unexpected_audio_formats(blob: types.Blob) -> None:
    synthesizer = GeminiSpeechSynthesizer(
        client_factory=factory(FakeClient([audio_response([blob])]), []),
        location="us",
        model="gemini-3.8-flash-tts",
        voice="Kore",
    )
    with pytest.raises(ValueError):
        list(synthesizer.synthesize("こんにちは", "やさしく"))


def test_vertex_client_factory_builds_enterprise_clients_on_demand(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: list[dict[str, Any]] = []

    def fake_client(**kwargs: Any) -> str:
        created.append(kwargs)
        return "client"

    monkeypatch.setattr(genai, "Client", fake_client)
    create = vertex_client_factory("demo-project")
    assert created == []
    assert cast(object, create("us")) == "client"
    assert cast(object, create("us")) == "client"
    assert cast(object, create("global")) == "client"
    assert [(item["location"], item["enterprise"], item["project"]) for item in created] == [
        ("us", True, "demo-project"),
        ("global", True, "demo-project"),
    ]
    assert created[0]["http_options"].timeout == 30_000


def test_default_thinking_sends_no_thinking_setting() -> None:
    client = FakeClient([text_response("はい")])
    writer = GeminiReplyWriter(
        client_factory=factory(client, []),
        location="global",
        model="gemini-3.5-flash-lite",
        thinking_level="default",
    )
    list(writer.write(ReplyPrompt("s", "u")))
    assert client.models.calls[0]["config"].thinking_config is None
