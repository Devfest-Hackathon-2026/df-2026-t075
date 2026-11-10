"""Cloud Speech-to-Text V2 streaming recognition."""

from collections.abc import Callable, Iterator, Sequence
from datetime import timedelta

from google.api_core.client_options import ClientOptions
from google.cloud import speech_v2
from google.cloud.speech_v2.types import cloud_speech

from classroom_agent.application.voice_check import RecognitionEvent

ClientFactory = Callable[[ClientOptions], speech_v2.SpeechClient]
Sensitivity = cloud_speech.StreamingRecognitionFeatures.EndpointingSensitivity
ENDPOINTING = {
    "standard": Sensitivity.ENDPOINTING_SENSITIVITY_STANDARD,
    "short": Sensitivity.ENDPOINTING_SENSITIVITY_SHORT,
    "supershort": Sensitivity.ENDPOINTING_SENSITIVITY_SUPERSHORT,
}
# Up to 60 s of audio plus trailing silence and the final result.
STREAM_TIMEOUT_SECONDS = 120.0


def _default_client(options: ClientOptions) -> speech_v2.SpeechClient:
    return speech_v2.SpeechClient(client_options=options)


class CloudSpeechRecognizer:
    """Create the client on first use, then keep it so later turns skip the setup."""

    def __init__(
        self,
        *,
        project: str,
        location: str,
        model: str,
        endpointing: str = "standard",
        language_code: str = "ja-JP",
        phrases: Sequence[str] = (),
        client_factory: ClientFactory = _default_client,
    ) -> None:
        self._project = project
        self._location = location
        self._model = model
        self._endpointing = ENDPOINTING[endpointing]
        self._language_code = language_code
        self._phrases = tuple(phrases)
        self._client_factory = client_factory
        self._client: speech_v2.SpeechClient | None = None

    def _endpoint(self) -> str:
        if self._location == "global":
            return "speech.googleapis.com"
        return f"{self._location}-speech.googleapis.com"

    def _config(self, sample_rate: int) -> cloud_speech.StreamingRecognitionConfig:
        adaptation = None
        if self._phrases:
            adaptation = cloud_speech.SpeechAdaptation(
                phrase_sets=[
                    cloud_speech.SpeechAdaptation.AdaptationPhraseSet(
                        inline_phrase_set=cloud_speech.PhraseSet(
                            phrases=[
                                cloud_speech.PhraseSet.Phrase(value=phrase, boost=10.0)
                                for phrase in self._phrases
                            ]
                        )
                    )
                ]
            )
        return cloud_speech.StreamingRecognitionConfig(
            config=cloud_speech.RecognitionConfig(
                explicit_decoding_config=cloud_speech.ExplicitDecodingConfig(
                    encoding=cloud_speech.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                    sample_rate_hertz=sample_rate,
                    audio_channel_count=1,
                ),
                language_codes=[self._language_code],
                model=self._model,
                features=cloud_speech.RecognitionFeatures(enable_automatic_punctuation=True),
                adaptation=adaptation,
            ),
            streaming_features=cloud_speech.StreamingRecognitionFeatures(
                endpointing_sensitivity=self._endpointing
            ),
        )

    def recognize(self, chunks: Iterator[bytes], sample_rate: int) -> Iterator[RecognitionEvent]:
        if self._client is None:
            # A personal login (ADC) has no quota project unless one is set; bill this project.
            self._client = self._client_factory(
                ClientOptions(api_endpoint=self._endpoint(), quota_project_id=self._project)
            )
        recognizer = f"projects/{self._project}/locations/{self._location}/recognizers/_"
        config = self._config(sample_rate)

        def requests() -> Iterator[cloud_speech.StreamingRecognizeRequest]:
            yield cloud_speech.StreamingRecognizeRequest(
                recognizer=recognizer, streaming_config=config
            )
            for chunk in chunks:
                yield cloud_speech.StreamingRecognizeRequest(audio=chunk)

        responses = self._client.streaming_recognize(
            requests=requests(), timeout=STREAM_TIMEOUT_SECONDS
        )
        try:
            for response in responses:
                billed = response.metadata.total_billed_duration if response.metadata else None
                # Proto Plus exposes populated Duration fields as datetime.timedelta.
                billed_seconds = billed.total_seconds() if isinstance(billed, timedelta) else None
                results = list(response.results)
                if not results and billed_seconds is not None:
                    yield RecognitionEvent("", is_final=False, billed_seconds=billed_seconds)
                for result in results:
                    text = result.alternatives[0].transcript if result.alternatives else ""
                    yield RecognitionEvent(
                        text, is_final=result.is_final, billed_seconds=billed_seconds
                    )
        finally:
            # The caller may stop reading once it has the final result; end the stream then.
            cancel = getattr(responses, "cancel", None)
            if callable(cancel):
                cancel()
