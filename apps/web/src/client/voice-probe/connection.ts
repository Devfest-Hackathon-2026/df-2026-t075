import { LogLevel, Room, RoomEvent, setLogLevel, Track } from "livekit-client";
import type { ProbeAudio } from "./audio";

// Output includes thinking; `thoughts` is the thinking part, when the worker reports it.
type Tokens = {
  prompt: number;
  output: number;
  cached: number;
  thoughts?: number;
};
const thinkingLevels = ["default", "low", "medium", "high"] as const;
export type Report = {
  reply_model?: "gemini-3.8-flash" | "gemini-3.5-flash-lite";
  reply_thinking?: (typeof thinkingLevels)[number];
  window_s: number;
  stt_audio_s: number;
  endpoint_ms: number;
  stt_ms: number;
  gemini_ms: number;
  tts_first_ms: number;
  voice_latency_ms: number;
  llm_tokens: Tokens | null;
  tts_tokens: Tokens | null;
  google_usd_per_min: number | null;
};
type Callbacks = {
  ready: () => void;
  caption: (speaker: "user" | "ai", text: string) => void;
};
const errors: Record<string, string> = {
  operator: "検証キーまたはサーバー設定を確認してください。",
  connection:
    "LiveKitへの接続が切れました。接続先を確認して、もう一度試してください。",
  worker: "ノトが入室できませんでした。ワーカーの起動を確認してください。",
  microphone: "マイクへのアクセスを許可してください。",
  recording:
    "20秒以内・8 MB以下の、ブラウザで読み込める音声ファイルを選んでください。",
  audio: "音声再生を開始できませんでした。タブを開いてもう一度試してください。",
  setup:
    "音声サービスを開始できませんでした。Google Cloudの設定を確認してください。",
  no_speech:
    "発話を認識できませんでした。マイクを確認してもう一度試してください。",
  too_long: "発話が20秒を超えました。短い一文で試してください。",
  stt: "音声を文字にできませんでした。Speech-to-Textの設定を確認してください。",
  gemini: "Geminiの返答を取得できませんでした。",
  tts: "音声を生成できませんでした。返答は字幕で読めます。",
  timeout: "制限時間に達しました。もう一度試してください。",
};
export class ProbeFailure extends Error {
  constructor(stage: string) {
    super(errors[stage] ?? errors.connection);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function tokens(value: unknown): value is Tokens | null {
  return (
    value === null ||
    (object(value) &&
      number(value.prompt) &&
      number(value.output) &&
      number(value.cached) &&
      (value.thoughts === undefined || number(value.thoughts)))
  );
}
function isReport(value: unknown): value is Report {
  return (
    object(value) &&
    (value.reply_model === undefined ||
      value.reply_model === "gemini-3.8-flash" ||
      value.reply_model === "gemini-3.5-flash-lite") &&
    (value.reply_thinking === undefined ||
      thinkingLevels.some((level) => level === value.reply_thinking)) &&
    [
      "window_s",
      "stt_audio_s",
      "endpoint_ms",
      "stt_ms",
      "gemini_ms",
      "tts_first_ms",
      "voice_latency_ms",
    ].every((k) => number(value[k])) &&
    tokens(value.llm_tokens) &&
    tokens(value.tts_tokens) &&
    (value.google_usd_per_min === null || number(value.google_usd_per_min))
  );
}

export async function connectProbe(
  key: string,
  signal: AbortSignal,
  audio: ProbeAudio,
  events: Callbacks,
  recording?: File,
) {
  setLogLevel(LogLevel.silent);
  const room = new Room({ webAudioMix: { audioContext: audio.context } });
  const players = new Set<HTMLMediaElement>();
  let finish!: (result: Report | ProbeFailure) => void;
  const outcome = new Promise<Report | ProbeFailure>((resolve) => {
    finish = resolve;
  });
  let mic: MediaStreamTrack | undefined;
  let listening = false;
  let published = false;
  let started = false;
  let startRecording: (() => void) | undefined;
  function onReady() {
    if (!started && listening && published && !signal.aborted) {
      started = true;
      events.ready();
      startRecording?.();
    }
  }
  let waitTimer: number | undefined;
  const abort = () => {
    mic?.stop();
    finish(new ProbeFailure("timeout"));
    void room.disconnect();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch("/api/internal/voice-probe", {
      method: "POST",
      signal,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ adultAndConsenting: true }),
    });
    if (!response.ok) throw new ProbeFailure("operator");
    const session = await response.json();
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (
        participant.identity === "ainote-voice-probe" &&
        track.kind === Track.Kind.Audio
      ) {
        // Attaching the element starts the WebRTC decoder in Chromium. LiveKit
        // routes playout through the context resumed by the operator's click.
        const player = track.attach();
        player.hidden = true;
        document.body.append(player);
        players.add(player);
        audio.watch(track.mediaStreamTrack, true);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const player of track.detach()) {
        player.remove();
        players.delete(player);
      }
    });
    room.on(RoomEvent.Disconnected, () =>
      finish(new ProbeFailure("connection")),
    );
    room.on(RoomEvent.DataReceived, (data, sender, _kind, topic) => {
      if (
        topic !== "ainote.voice-probe.v1" ||
        sender?.identity !== "ainote-voice-probe" ||
        data.length > 16_384
      )
        return;
      let packet: unknown;
      try {
        packet = JSON.parse(new TextDecoder().decode(data));
      } catch {
        return;
      }
      if (!object(packet)) return;
      if (packet.type === "ready") {
        window.clearTimeout(waitTimer);
        listening = true;
        onReady();
      } else if (
        packet.type === "caption" &&
        (packet.speaker === "ai" || packet.speaker === "user") &&
        typeof packet.text === "string"
      ) {
        if (packet.speaker === "user") {
          audio.finishMic();
          mic?.stop();
        }
        events.caption(packet.speaker, packet.text);
      } else if (packet.type === "result" && isReport(packet)) {
        finish(packet);
      } else if (packet.type === "error" && typeof packet.stage === "string") {
        finish(new ProbeFailure(packet.stage));
      }
    });
    try {
      if (recording) {
        const source = await audio.recording(recording);
        mic = source.track;
        startRecording = source.start;
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        });
        mic = stream.getAudioTracks()[0];
      }
      if (!mic) throw new ProbeFailure("microphone");
    } catch {
      throw new ProbeFailure(recording ? "recording" : "microphone");
    }
    signal.throwIfAborted();
    audio.watch(mic, false);
    await room.connect(session.url, session.token);
    signal.throwIfAborted();
    await room.localParticipant.publishTrack(mic, {
      source: Track.Source.Microphone,
    });
    published = true;
    if (listening) onReady();
    else
      waitTimer = window.setTimeout(
        () => finish(new ProbeFailure("worker")),
        25_000,
      );
    const result = await outcome;
    if (result instanceof ProbeFailure) throw result;
    // Leave time for the browser's jitter buffer to play the tail after the server drains.
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    return { report: result, browserMs: audio.latencyMs() };
  } finally {
    window.clearTimeout(waitTimer);
    signal.removeEventListener("abort", abort);
    mic?.stop();
    await room.disconnect();
    players.forEach((player) => player.remove());
  }
}
