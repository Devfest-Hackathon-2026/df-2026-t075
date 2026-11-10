import {
  ConnectionState,
  createLocalVideoTrack,
  LogLevel,
  Room,
  RoomEvent,
  setLogLevel,
  Track,
  VideoPresets43,
} from "livekit-client";
import type {
  Participant,
  RemoteTrack,
  VideoCaptureOptions,
} from "livekit-client";
import type { SignInConfig } from "./firebase-auth";
import { roomRequest } from "./rooms";

const agent = "ainote-meeting";
const topic = "ainote.meeting.voice.v1";
const cameraOptions: VideoCaptureOptions = {
  facingMode: "user",
  resolution: VideoPresets43.h480.resolution,
};

export type CameraTrack = {
  attach(video: HTMLVideoElement): void;
  detach(video: HTMLVideoElement): void;
};
export type PreviewCamera = CameraTrack & { stop(): void };

export function openCameraPreview(): Promise<PreviewCamera> {
  setLogLevel(LogLevel.silent);
  return createLocalVideoTrack(cameraOptions);
}

function activeCamera(participant: Participant): CameraTrack | null {
  const publication = participant.getTrackPublication(Track.Source.Camera);
  return publication?.isMuted ? null : (publication?.videoTrack ?? null);
}

export type CallState = {
  connected: boolean;
  reconnecting: boolean;
  microphone: boolean;
  microphoneTrack: MediaStreamTrack | null;
  camera: CameraTrack | null;
  playbackBlocked: boolean;
  peers: {
    id: string;
    name: string;
    muted: boolean;
    camera: CameraTrack | null;
  }[];
  phase: string;
  ownerName: string;
  myTurn: boolean;
};
export const disconnected: CallState = {
  connected: false,
  reconnecting: false,
  microphone: false,
  microphoneTrack: null,
  camera: null,
  playbackBlocked: false,
  peers: [],
  phase: "",
  ownerName: "",
  myTurn: false,
};

type Events = {
  researchChanged: () => void;
  state: (state: CallState) => void;
  caption: (speaker: "user" | "ai", name: string, text: string) => void;
  error: (message: string) => void;
  ended: () => void;
};

export class MeetingCall {
  private readonly room: Room;
  private readonly abort = new AbortController();
  private readonly players = new Map<RemoteTrack, HTMLMediaElement>();

  constructor(private readonly events: Events) {
    setLogLevel(LogLevel.silent);
    this.room = new Room();
    const room = this.room;
    const refresh = () => this.refresh();
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ParticipantAttributesChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ConnectionStateChanged, refresh)
      .on(RoomEvent.AudioPlaybackStatusChanged, refresh)
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (this.abort.signal.aborted) return;
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach();
          element.hidden = true;
          element.setAttribute(
            "aria-label",
            participant.identity === agent ? "AIの音声" : "参加者の音声",
          );
          document.body.append(element);
          this.players.set(track, element);
        }
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        // The SDK detaches the track before emitting this event. It leaves the DOM to us.
        this.players.get(track)?.remove();
        this.players.delete(track);
        refresh();
      })
      .on(RoomEvent.DataReceived, (bytes, sender, _kind, receivedTopic) => {
        if (
          this.abort.signal.aborted ||
          sender?.identity !== agent ||
          receivedTopic !== topic ||
          bytes.length > 16384
        )
          return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(bytes));
          if (
            msg?.type === "caption" &&
            (msg.speaker === "user" || msg.speaker === "ai") &&
            typeof msg.text === "string"
          ) {
            this.events.caption(msg.speaker, this.nameFor(msg.owner), msg.text);
          } else if (msg?.type === "research_changed") {
            this.events.researchChanged();
          } else if (msg?.type === "error") {
            const message =
              msg.stage === "research_unavailable"
                ? "この調査結果は現在読み上げられません。参考資料で確認できます。"
                : msg.stage === "timeout"
                  ? "AIの応答が時間切れになりました。"
                  : msg.stage === "tts"
                    ? "読み上げに失敗しました。返答は字幕で読めます。"
                    : msg.stage === "no_speech"
                      ? "声を認識できませんでした。もう一度話してください。"
                      : msg.stage === "stt"
                        ? "質問の文字起こしに失敗しました。もう一度話してください。"
                        : "AIの返答を完了できませんでした。もう一度質問してください。";
            this.events.error(message);
          }
        } catch {
          /* Ignore malformed packets. */
        }
      })
      .on(RoomEvent.Disconnected, () => {
        if (!this.abort.signal.aborted) {
          this.close();
          this.events.ended();
        }
      });
  }

  private nameFor(id: string) {
    return id === this.room.localParticipant.identity
      ? "あなた"
      : this.room.remoteParticipants.get(id)?.name || "参加者";
  }

  private refresh() {
    if (this.abort.signal.aborted) return;
    const room = this.room;
    const attrs = room.remoteParticipants.get(agent)?.attributes ?? {};
    const owner = attrs["ainote.owner"] ?? "";
    this.events.state({
      connected: room.state === ConnectionState.Connected,
      reconnecting:
        room.state === ConnectionState.Reconnecting ||
        room.state === ConnectionState.SignalReconnecting,
      microphone: room.localParticipant.isMicrophoneEnabled,
      microphoneTrack: room.localParticipant.isMicrophoneEnabled
        ? (room.localParticipant.getTrackPublication(Track.Source.Microphone)
            ?.audioTrack?.mediaStreamTrack ?? null)
        : null,
      camera: activeCamera(room.localParticipant),
      playbackBlocked: !room.canPlaybackAudio,
      peers: Array.from(room.remoteParticipants.values())
        .filter((p) => p.identity !== agent)
        .map((p) => ({
          id: p.identity,
          name: p.name || "参加者",
          muted: !p.isMicrophoneEnabled,
          camera: activeCamera(p),
        })),
      phase: attrs["ainote.phase"] ?? "",
      ownerName: owner ? this.nameFor(owner) : "",
      myTurn: Boolean(owner) && owner === room.localParticipant.identity,
    });
  }

  async join(config: SignInConfig, roomId: string) {
    void this.playAudio();
    const { signal } = this.abort;
    const session = await roomRequest<{ url: string; token: string }>(
      config,
      `/api/meetings/${roomId}/voice`,
      "POST",
      undefined,
      signal,
    );
    signal.throwIfAborted();
    await this.room.connect(session.url, session.token);
    signal.throwIfAborted();
    this.refresh();
  }

  async microphone(enabled: boolean) {
    try {
      const publication = await this.room.localParticipant.setMicrophoneEnabled(
        enabled,
        { echoCancellation: true, noiseSuppression: true },
      );
      if (this.abort.signal.aborted) publication?.track?.stop();
    } catch {
      if (!this.abort.signal.aborted)
        this.events.error(
          "マイクを使えません。ブラウザのマイク許可を確認してください。",
        );
    }
    this.refresh();
  }

  async playAudio() {
    try {
      await this.room.startAudio();
    } catch {
      if (!this.abort.signal.aborted)
        this.events.error(
          "「音声を再生」を押して通話の音を有効にしてください。",
        );
    }
    this.refresh();
  }

  async camera(enabled: boolean) {
    try {
      const publication = await this.room.localParticipant.setCameraEnabled(
        enabled,
        cameraOptions,
      );
      if (this.abort.signal.aborted) publication?.track?.stop();
    } catch {
      if (!this.abort.signal.aborted)
        this.events.error(
          "カメラを切り替えられません。ブラウザのカメラ許可と端末を確認してください。",
        );
    }
    this.refresh();
  }

  async ask(finish: boolean, researchId?: string) {
    const attrs = this.room.remoteParticipants.get(agent)?.attributes;
    try {
      const result = await this.room.localParticipant.performRpc({
        destinationIdentity: agent,
        method: topic,
        responseTimeout: 5000,
        payload: researchId
          ? "present:" + researchId
          : finish
            ? "finish:" + attrs?.["ainote.turn"]
            : "start",
      });
      if (result === "ok" || this.abort.signal.aborted) return;
      this.events.error(
        result === "busy"
          ? "ほかの人の質問が終わってから話してください。"
          : "AIの準備ができてからもう一度押してください。",
      );
    } catch {
      if (!this.abort.signal.aborted)
        this.events.error(
          "AIへの合図が届きませんでした。通話の状態を確認してください。",
        );
    }
  }

  close() {
    this.abort.abort();
    for (const player of this.players.values()) player.remove();
    this.players.clear();
    void this.room.disconnect();
  }
}
