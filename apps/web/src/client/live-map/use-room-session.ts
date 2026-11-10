import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { DiscussionGraph, Utterance } from "../discussion-map/types";
import type { SignInConfig } from "../infrastructure/firebase-auth";
import { roomRequest } from "../infrastructure/rooms";
import { MeetingAudio } from "./audio";

export type Turn = Utterance & {
  state:
    | "recognizing"
    | "queued"
    | "mapping"
    | "mapped"
    | "failed"
    | "skipped"
    | "unheard"
    | "speech-error";
  delayMs?: number;
};
type State = {
  mappingEnabled?: boolean;
  members: { name: string; connected: boolean; mic: boolean }[];
  turns: Turn[];
  graph: DiscussionGraph;
  waiting: number;
  expires: number;
  canRetry: boolean;
};
type Welcome = {
  type: "joined";
  name: string;
  host: boolean;
  inviteUrl?: string;
  sharing?: "ready" | "starting" | "failed";
  resume?: string;
};
const empty: State = {
  members: [],
  turns: [],
  graph: { nodes: [], edges: [] },
  waiting: 0,
  expires: 0,
  canRetry: true,
};
const errors: Record<string, string> = {
  membership: "参加状態が変わりました。部屋を開き直してください。",
  "room-busy":
    "この部屋に接続できませんでした。少し待ってからもう一度参加してください。",
  capacity:
    "ライブマップが混み合っています。少し待ってからもう一度参加してください。",
  "second-tab":
    "別のタブでこの会議に接続中です。そちらのタブを閉じてから再接続してください。",
  invite:
    "招待リンクが違うか、部屋が終了しました。主催者から新しいリンクを受け取ってください。",
  expired: "前回の部屋は終了したか、接続がまだ残っています。",
  occupied: "このMacで別の部屋が開いています。作成したタブに戻ってください。",
  full: "この部屋は同時に4人まで参加できます。",
  name: "その名前は使用されています。別の名前を入力してください。",
  invalid: "名前・発言の長さと参加への同意を確認してください。",
  limit:
    "発言を追加できませんでした。少し待ってから、もう一度発言してください。",
};

type MemberSession = {
  config: SignInConfig;
  roomId: string;
  enabled: boolean;
  voiceViaLiveKit: boolean;
  microphone: MediaStreamTrack | null;
};
type DemoEntry =
  | { type: "resume"; token: string }
  | { type: "join" | "create"; name: string; consent: boolean; invite: string };
type MapTicket = { url: string; roomId: string; uid: string; ticket: string };
export const demoSessionKey = "ainote-live-map-session";

export function useRoomSession(member?: MemberSession) {
  const [welcome, setWelcome] = useState<Welcome | null>(null);
  const [connecting, setConnecting] = useState(Boolean(member?.enabled));
  const [state, setState] = useState(empty);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [mic, setMic] = useState(false),
    [micBusy, setMicBusy] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const socket = useRef<WebSocket | null>(null),
    audio = useRef<MeetingAudio | null>(null);
  const admission = useRef<AbortController | null>(null),
    micEnabled = useRef(false);
  const captureVersion = useRef(0);

  function stopMic() {
    captureVersion.current++;
    micEnabled.current = false;
    audio.current?.stopMic();
    setMic(false);
    setMicBusy(false);
    send({ type: "mic", on: false });
  }
  function send(message: object) {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(message));
  }
  function makeAudio() {
    const sound = new MeetingAudio(() => {
      if (audio.current === sound) setPlaybackBlocked(sound.playbackBlocked);
    });
    audio.current = sound;
    setPlaybackBlocked(sound.playbackBlocked);
    return sound;
  }
  function playAudio() {
    const sound = audio.current;
    void sound?.resume().catch(() => {
      if (audio.current === sound) setError("音声再生を開始できません。");
    });
  }
  async function connect(entry?: DemoEntry) {
    if (socket.current || admission.current || (!member?.enabled && !entry))
      return;
    setError("");
    setNotice("");
    setConnecting(true);
    try {
      if (!member?.voiceViaLiveKit) {
        makeAudio();
        playAudio();
      }
    } catch {
      setNotice("このブラウザでは音声を使えません。文字で参加できます。");
    }
    const ctl = new AbortController();
    admission.current = ctl;
    let proof: MapTicket | undefined;
    let ws: WebSocket;
    try {
      if (member)
        proof = await roomRequest<MapTicket>(
          member.config,
          "/api/meetings/" + member.roomId + "/map",
          "POST",
          undefined,
          ctl.signal,
        );
      if (ctl.signal.aborted) return;
      ws = new WebSocket(
        proof?.url ??
          (location.protocol === "https:" ? "wss://" : "ws://") +
            location.host +
            "/live-map/socket",
      );
    } catch (e) {
      if (!ctl.signal.aborted) {
        setConnecting(false);
        setError(e instanceof Error ? e.message : "接続できませんでした。");
        audio.current?.close();
        audio.current = null;
      }
      return;
    } finally {
      if (admission.current === ctl) admission.current = null;
    }
    socket.current = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (socket.current === ws)
        ws.send(
          JSON.stringify(
            proof
              ? {
                  type: "member",
                  peerAudio: !member?.voiceViaLiveKit,
                  roomId: proof.roomId,
                  uid: proof.uid,
                  ticket: proof.ticket,
                }
              : entry,
          ),
        );
    };
    let joined = false,
      finished = false,
      rejected = false;
    function forgetDemo() {
      if (!member) {
        sessionStorage.removeItem(demoSessionKey);
        sessionStorage.removeItem(demoSessionKey + "-invite");
      }
    }
    ws.onmessage = (e) => {
      if (socket.current !== ws) return;
      if (e.data instanceof ArrayBuffer) {
        if (!member?.voiceViaLiveKit) audio.current?.play(e.data);
        return;
      }
      const m = JSON.parse(e.data);
      if (m.type === "joined") {
        joined = true;
        setWelcome(m);
        setConnecting(false);
        if (!member) {
          sessionStorage.setItem(demoSessionKey, m.resume);
          sessionStorage.setItem(
            demoSessionKey + "-invite",
            location.hash.slice(1),
          );
        }
      } else if (m.type === "share") {
        setWelcome((w) =>
          w ? { ...w, inviteUrl: m.inviteUrl, sharing: m.sharing } : w,
        );
      } else if (m.type === "state") setState(m);
      else if (m.type === "left" || m.type === "ended") {
        finished = true;
        forgetDemo();
        setState(empty);
        setWelcome(null);
        setNotice(
          member
            ? "会議の接続が終了しました。"
            : m.type === "left"
              ? "退室しました。"
              : "部屋が終了しました。発言とマップを消去しました。",
        );
      } else if (m.type === "error") {
        rejected = true;
        setError(errors[m.code] ?? "操作に失敗しました。");
        if (m.code === "expired") forgetDemo();
      }
    };
    ws.onclose = () => {
      if (socket.current !== ws) return;
      socket.current = null;
      captureVersion.current++;
      micEnabled.current = false;
      audio.current?.close();
      audio.current = null;
      setMic(false);
      setMicBusy(false);
      setPlaybackBlocked(false);
      setConnecting(false);
      setState(empty);
      setWelcome(null);
      if (!finished && !rejected)
        setNotice(
          member
            ? "接続が切れました。再接続してください。"
            : joined
              ? "接続が切れました。「再接続」で部屋に戻れます。"
              : "デモに接続できません。主催者の画面または招待リンクを確認してください。",
        );
    };
  }
  async function startMic(track?: MediaStreamTrack) {
    const ws = socket.current;
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      (member?.voiceViaLiveKit && !track)
    )
      return;
    const version = ++captureVersion.current;
    setMicBusy(true);
    setError("");
    try {
      const sound = audio.current ?? makeAudio();
      await sound.mic(
        (frame) => {
          if (
            micEnabled.current &&
            captureVersion.current === version &&
            ws.readyState === WebSocket.OPEN &&
            ws.bufferedAmount < 16000
          )
            ws.send(frame);
        },
        stopMic,
        track,
      );
      if (
        captureVersion.current !== version ||
        socket.current !== ws ||
        ws.readyState !== WebSocket.OPEN
      )
        return;
      ws.send(JSON.stringify({ type: "mic", on: true }));
      micEnabled.current = true;
      setMic(true);
    } catch {
      if (socket.current === ws && captureVersion.current === version)
        setError(
          track
            ? "マイクの音声を議論マップに送れませんでした。"
            : "マイクを開始できません。ブラウザのマイク許可を確認してください。",
        );
    } finally {
      if (captureVersion.current === version) setMicBusy(false);
    }
  }
  const autoConnect = useEffectEvent(() => {
    void connect();
  });
  const enabled = member?.enabled,
    roomId = member?.roomId,
    viaLiveKit = member?.voiceViaLiveKit;
  useEffect(() => {
    // StrictMode can tear the meeting down before its first admission request.
    let mounted = true;
    if (enabled)
      queueMicrotask(() => {
        if (mounted) autoConnect();
      });
    return () => {
      mounted = false;
      admission.current?.abort();
      admission.current = null;
      const ws = socket.current;
      socket.current = null;
      ws?.close();
      micEnabled.current = false;
      audio.current?.close();
      audio.current = null;
    };
  }, [roomId, enabled, viaLiveKit]);

  // LiveKit owns the microphone. Mirror its current track for captions only, without opening another device.
  const mirrorTrack = useEffectEvent((track: MediaStreamTrack) => {
    void startMic(track);
  });
  const unmirror = useEffectEvent(stopMic);
  const primaryTrack = member?.microphone,
    connected = !!welcome,
    mapping = state.mappingEnabled !== false;
  useEffect(() => {
    if (viaLiveKit && connected && mapping && primaryTrack) {
      let mounted = true;
      queueMicrotask(() => {
        if (mounted) mirrorTrack(primaryTrack);
      });
      return () => {
        mounted = false;
        unmirror();
      };
    }
  }, [viaLiveKit, connected, mapping, primaryTrack]);

  return {
    welcome,
    connecting,
    state,
    notice,
    setNotice,
    error,
    mic,
    micBusy,
    playbackBlocked,
    playAudio,
    connect,
    send,
    toggleMic: () => {
      if (mic) stopMic();
      else void startMic();
    },
  };
}
export type RoomSession = ReturnType<typeof useRoomSession>;
