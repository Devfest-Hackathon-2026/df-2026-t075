"""Gemini on Vertex AI: the reply text and the AI member's voice."""

import io
import re
import wave
from collections.abc import Callable, Iterator

from google import genai
from google.genai import types

from classroom_agent.application.voice_check import ReplyChunk, ReplyPrompt, VoiceChunk
from classroom_agent.domain.voice_cost import Tokens

ClientFactory = Callable[[str], genai.Client]
STREAMING_SAMPLE_RATE = 24_000
# One reply took 134 s on 2026-11-08; give up instead of hanging the turn.
REQUEST_TIMEOUT_MS = 30_000
# Replies are asked to stay within 50 characters. The cap leaves room for thinking,
# which 3.8 Flash spent 200 to 550 tokens on at "low" on 2026-11-08.
REPLY_MAX_OUTPUT_TOKENS = 1024


def thinking_config(level: str) -> types.ThinkingConfig | None:
    """`default` sends no setting, so a model such as Flash-Lite decides (and need not think)."""
    if level == "default":
        return None
    return types.ThinkingConfig(thinking_level=types.ThinkingLevel(level.upper()))


def vertex_client_factory(project: str) -> ClientFactory:
    """Return a factory that builds one client per location on first use and reuses it."""
    clients: dict[str, genai.Client] = {}

    def create(location: str) -> genai.Client:
        if location not in clients:
            clients[location] = genai.Client(
                enterprise=True,
                project=project,
                location=location,
                http_options=types.HttpOptions(timeout=REQUEST_TIMEOUT_MS),
            )
        return clients[location]

    return create


def response_tokens(response: types.GenerateContentResponse) -> Tokens | None:
    usage = response.usage_metadata
    if usage is None or usage.prompt_token_count is None or usage.candidates_token_count is None:
        return None
    thoughts = usage.thoughts_token_count or 0
    return Tokens(
        prompt=usage.prompt_token_count,
        output=usage.candidates_token_count + thoughts,
        cached=usage.cached_content_token_count or 0,
        thoughts=thoughts,
    )


def reply_contents(prompt: ReplyPrompt) -> list[types.Content]:
    messages = [
        types.Content(
            role="user" if item.speaker == "participant" else "model",
            parts=[types.Part(text=item.text)],
        )
        for item in prompt.history
    ]
    parts = [types.Part(text=prompt.user)]
    if prompt.context:
        parts.insert(0, types.Part(text=prompt.context))
    messages.append(types.Content(role="user", parts=parts))
    return messages


def speech_contents(text: str, style: str) -> list[types.Content]:
    return [
        types.Content(
            role="user",
            parts=[types.Part(text=text, speech_metadata=types.SpeechMetadata(style=style))],
        )
    ]


class GeminiReplyWriter:
    def __init__(
        self,
        *,
        client_factory: ClientFactory,
        location: str,
        model: str,
        thinking_level: str,
    ) -> None:
        self._client_factory = client_factory
        self._location = location
        self._model = model
        self._thinking = thinking_config(thinking_level)

    def write(self, prompt: ReplyPrompt) -> Iterator[ReplyChunk]:
        client = self._client_factory(self._location)
        stream = client.models.generate_content_stream(
            model=self._model,
            contents=reply_contents(prompt),
            config=types.GenerateContentConfig(
                system_instruction=prompt.system,
                max_output_tokens=REPLY_MAX_OUTPUT_TOKENS,
                thinking_config=self._thinking,
            ),
        )
        for response in stream:
            yield ReplyChunk(response.text or "", response_tokens(response))


def _pcm_from(blob: types.Blob) -> bytes:
    data = blob.data or b""
    if data[:4] == b"RIFF":
        with wave.open(io.BytesIO(data), "rb") as reader:
            if (reader.getnchannels(), reader.getsampwidth()) != (1, 2):
                raise ValueError("unsupported voice format")
            if reader.getframerate() != STREAMING_SAMPLE_RATE:
                raise ValueError("unexpected voice sample rate")
            return reader.readframes(reader.getnframes())
    rate = re.search(r"rate=(\d+)", blob.mime_type or "")
    if rate and int(rate.group(1)) != STREAMING_SAMPLE_RATE:
        raise ValueError("unexpected voice sample rate")
    return data


class GeminiSpeechSynthesizer:
    """Streaming output is raw 16-bit PCM at 24 kHz, mono."""

    sample_rate = STREAMING_SAMPLE_RATE

    def __init__(
        self, *, client_factory: ClientFactory, location: str, model: str, voice: str
    ) -> None:
        self._client_factory = client_factory
        self._location = location
        self._model = model
        self._voice = voice

    def synthesize(self, text: str, style: str) -> Iterator[VoiceChunk]:
        client = self._client_factory(self._location)
        stream = client.models.generate_content_stream(
            model=self._model,
            contents=speech_contents(text, style),
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(voice=self._voice)),
            ),
        )
        for response in stream:
            pcm = b""
            for candidate in response.candidates or []:
                for part in (candidate.content.parts if candidate.content else None) or []:
                    if part.inline_data is not None:
                        pcm += _pcm_from(part.inline_data)
            yield VoiceChunk(pcm, response_tokens(response))
