from collections.abc import Generator, Iterable, Iterator
from datetime import timedelta
from typing import Any, cast

import pytest
from google.api_core.client_options import ClientOptions
from google.cloud import speech_v2
from google.cloud.speech_v2.types import cloud_speech

from classroom_agent.application.voice_check import RecognitionEvent
from classroom_agent.infrastructure.google_speech import CloudSpeechRecognizer


class Responses:
    """Like gRPC's streaming call: iterable, and cancellable once the reader stops."""

    def __init__(self, responses: list[cloud_speech.StreamingRecognizeResponse]) -> None:
        self._responses = iter(responses)
        self.cancelled = False

    def __iter__(self) -> Iterator[cloud_speech.StreamingRecognizeResponse]:
        return self._responses

    def cancel(self) -> None:
        self.cancelled = True


class FakeClient:
    def __init__(self, responses: list[cloud_speech.StreamingRecognizeResponse]) -> None:
        self.responses = responses
        self.requests: list[cloud_speech.StreamingRecognizeRequest] = []
        self.calls: list[Responses] = []
        self.timeouts: list[float] = []

    def streaming_recognize(
        self, *, requests: Iterable[cloud_speech.StreamingRecognizeRequest], timeout: float
    ) -> Responses:
        self.requests.extend(requests)
        self.timeouts.append(timeout)
        self.calls.append(Responses(self.responses))
        return self.calls[-1]


def result(text: str, *, final: bool) -> cloud_speech.StreamingRecognitionResult:
    return cloud_speech.StreamingRecognitionResult(
        alternatives=[cloud_speech.SpeechRecognitionAlternative(transcript=text)],
        is_final=final,
    )


def recognizer(
    client: FakeClient, options: list[ClientOptions], *, location: str = "us", **kwargs: Any
) -> CloudSpeechRecognizer:
    def factory(option: ClientOptions) -> speech_v2.SpeechClient:
        options.append(option)
        return cast(speech_v2.SpeechClient, client)

    return CloudSpeechRecognizer(
        project="demo-project",
        location=location,
        model="chirp_3",
        client_factory=factory,
        **kwargs,
    )


def test_streams_config_then_audio_and_maps_results() -> None:
    client = FakeClient(
        [
            cloud_speech.StreamingRecognizeResponse(results=[result("ノト", final=False)]),
            cloud_speech.StreamingRecognizeResponse(
                results=[
                    result("ノト、どう？", final=True),
                    cloud_speech.StreamingRecognitionResult(),
                ],
                metadata=cloud_speech.RecognitionResponseMetadata(
                    total_billed_duration=timedelta(seconds=4)
                ),
            ),
            cloud_speech.StreamingRecognizeResponse(
                metadata=cloud_speech.RecognitionResponseMetadata(
                    total_billed_duration=timedelta(seconds=5)
                )
            ),
            cloud_speech.StreamingRecognizeResponse(),
        ]
    )
    options: list[ClientOptions] = []
    events = list(recognizer(client, options).recognize(iter([b"ab", b"cd"]), 16_000))

    assert events == [
        RecognitionEvent("ノト", is_final=False),
        RecognitionEvent("ノト、どう？", is_final=True, billed_seconds=4.0),
        RecognitionEvent("", is_final=False, billed_seconds=4.0),
        RecognitionEvent("", is_final=False, billed_seconds=5.0),
    ]
    assert options[0].api_endpoint == "us-speech.googleapis.com"
    assert options[0].quota_project_id == "demo-project"
    assert client.timeouts == [120.0]
    first, *audio = client.requests
    assert first.recognizer == "projects/demo-project/locations/us/recognizers/_"
    config = first.streaming_config.config
    assert config.model == "chirp_3"
    assert list(config.language_codes) == ["ja-JP"]
    assert config.explicit_decoding_config.sample_rate_hertz == 16_000
    assert config.explicit_decoding_config.audio_channel_count == 1
    assert config.features.enable_automatic_punctuation
    assert not config.adaptation.phrase_sets
    sensitivity = cloud_speech.StreamingRecognitionFeatures.EndpointingSensitivity
    assert (
        first.streaming_config.streaming_features.endpointing_sensitivity
        == sensitivity.ENDPOINTING_SENSITIVITY_STANDARD
    )
    assert [request.audio for request in audio] == [b"ab", b"cd"]


def test_stopping_early_cancels_the_stream_and_the_client_is_reused() -> None:
    client = FakeClient(
        [
            cloud_speech.StreamingRecognizeResponse(results=[result("ノト", final=True)]),
            cloud_speech.StreamingRecognizeResponse(results=[result("続き", final=True)]),
        ]
    )
    options: list[ClientOptions] = []
    speech = recognizer(client, options, endpointing="supershort")
    events = cast(Generator[RecognitionEvent], speech.recognize(iter([b"ab"]), 16_000))
    assert next(events).text == "ノト"
    events.close()
    list(speech.recognize(iter([]), 16_000))

    assert [call.cancelled for call in client.calls] == [True, True]
    assert len(options) == 1
    sensitivity = cloud_speech.StreamingRecognitionFeatures.EndpointingSensitivity
    assert (
        client.requests[0].streaming_config.streaming_features.endpointing_sensitivity
        == sensitivity.ENDPOINTING_SENSITIVITY_SUPERSHORT
    )


@pytest.mark.parametrize(
    ("location", "endpoint"),
    [("global", "speech.googleapis.com"), ("eu", "eu-speech.googleapis.com")],
)
def test_endpoint_follows_the_location(location: str, endpoint: str) -> None:
    options: list[ClientOptions] = []
    list(recognizer(FakeClient([]), options, location=location).recognize(iter([]), 16_000))
    assert options[0].api_endpoint == endpoint


def test_phrases_become_an_inline_phrase_set() -> None:
    client = FakeClient([])
    options: list[ClientOptions] = []
    list(recognizer(client, options, phrases=["ノト"]).recognize(iter([]), 16_000))
    phrase_set = client.requests[0].streaming_config.config.adaptation.phrase_sets[0]
    phrase = phrase_set.inline_phrase_set.phrases[0]
    assert (phrase.value, phrase.boost) == ("ノト", 10.0)


def test_creating_the_recognizer_does_not_create_a_client() -> None:
    created: list[ClientOptions] = []

    def factory(option: ClientOptions) -> speech_v2.SpeechClient:
        created.append(option)
        raise AssertionError("must not be called")

    CloudSpeechRecognizer(
        project="demo-project", location="us", model="chirp_3", client_factory=factory
    )
    assert created == []
