import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SignInConfig } from "../infrastructure/firebase-auth";
import {
  MeetingCall,
  disconnected,
  type CallState,
} from "../infrastructure/meeting-voice";
import type { RoomVisit } from "../infrastructure/rooms";
import { CameraVideo } from "./member-camera";
import {
  AiTile,
  DeviceButton,
  PersonTile,
  SelfTile,
  SymbolIcon,
} from "./blocks";

function statusText(room: RoomVisit, state: CallState, joining: boolean) {
  if (state.reconnecting) return "音声通話に再接続しています…";
  if (!state.connected)
    return joining ? "音声通話に接続しています…" : "音声通話は未接続です。";
  switch (state.phase) {
    case "listening":
      return state.ownerName + "がAIに話しています";
    case "thinking":
      return room.member + "が考えています";
    case "speaking":
      return room.member + "が答えています";
    case "ready":
      return "音声通話中";
    default:
      return "参加者同士で通話できます · AIは未接続です";
  }
}

export function MeetingAudio({
  room,
  displayName,
  config,
  presentationTarget,
  researching,
  raisedId,
  refreshResearch,
  onMicrophone,
}: {
  room: RoomVisit;
  displayName: string | null;
  config: SignInConfig;
  presentationTarget: HTMLSpanElement | null;
  researching: boolean;
  raisedId: string | undefined;
  refreshResearch: () => Promise<void>;
  onMicrophone: (track: MediaStreamTrack | null) => void;
}) {
  const active = useRef<MeetingCall | null>(null);
  const [state, setState] = useState(disconnected);
  const [joining, setJoining] = useState(true);
  const [changingCamera, setChangingCamera] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [captions, setCaptions] = useState({ question: "", reply: "" });

  useEffect(() => {
    onMicrophone(state.microphoneTrack);
    return () => onMicrophone(null);
  }, [state.microphoneTrack, onMicrophone]);

  const autoJoin = useEffectEvent(() => {
    void join();
  });
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) autoJoin();
    });
    return () => {
      mounted = false;
      const call = active.current;
      active.current = null;
      call?.close();
    };
  }, [room.roomId]);

  function reset() {
    active.current = null;
    setState(disconnected);
    setJoining(false);
    setChangingCamera(false);
    setSending(false);
    setCaptions({ question: "", reply: "" });
  }

  async function join() {
    if (active.current) return;
    setError("");
    setJoining(true);
    const call = new MeetingCall({
      researchChanged: () => {
        if (active.current === call) void refreshResearch();
      },
      state: (value) => {
        if (active.current === call) setState(value);
      },
      caption: (speaker, name, text) => {
        if (active.current !== call) return;
        setCaptions((old) =>
          speaker === "ai"
            ? { ...old, reply: text }
            : { question: name + "　" + text, reply: "" },
        );
      },
      error: (message) => {
        if (active.current === call) setError(message);
      },
      ended: () => {
        if (active.current === call) {
          reset();
          setError("音声通話が切れました。再接続できます。");
        }
      },
    });
    active.current = call;
    try {
      await call.join(config, room.roomId);
    } catch {
      call.close();
      if (active.current === call) {
        reset();
        setError(
          "通話に接続できませんでした。入室状態と接続先を確認してください。",
        );
      }
    } finally {
      if (active.current === call) setJoining(false);
    }
  }
  const finish = state.phase === "listening" && state.myTurn;
  async function toggleCamera() {
    const call = active.current;
    if (!call || changingCamera) return;
    setChangingCamera(true);
    setError("");
    try {
      await call.camera(!state.camera);
    } finally {
      if (active.current === call) setChangingCamera(false);
    }
  }
  async function ask(present?: string) {
    const call = active.current;
    if (!call || sending) return;
    setSending(true);
    setError("");
    try {
      await call.ask(finish, present);
    } finally {
      if (active.current === call) setSending(false);
    }
  }
  const askButton = (
    <button
      className="btn allow-ai"
      disabled={
        !state.connected ||
        sending ||
        !(finish || (state.microphone && state.phase === "ready"))
      }
      onClick={() => void ask()}
    >
      {finish ? "話し終えた" : "AIに話す"}
    </button>
  );
  const presentButton = raisedId && state.connected && (
    <button
      className="btn"
      disabled={sending || state.phase !== "ready"}
      onClick={() => void ask(raisedId)}
    >
      どうぞ（調査結果）
    </button>
  );
  const aiState =
    state.phase === "thinking" || state.phase === "speaking"
      ? state.phase
      : raisedId && state.phase === "ready"
        ? "raised"
        : state.phase
          ? "listening"
          : "idle";
  return (
    <>
      <div className="video-grid">
        <SelfTile displayName={displayName} muted={!state.microphone}>
          {state.camera && (
            <CameraVideo track={state.camera} label="自分のカメラ映像" />
          )}
        </SelfTile>
        {state.peers.map((p) => (
          <PersonTile
            key={p.id}
            person={{
              name: p.name,
              initial: Array.from(p.name)[0] ?? "人",
              color: "mint",
            }}
            muted={p.muted}
          >
            {p.camera && (
              <CameraVideo track={p.camera} label={p.name + "のカメラ映像"} />
            )}
          </PersonTile>
        ))}
        <div className="ai-wrap">
          <AiTile
            member={room.member}
            state={aiState}
            researching={researching}
          />
          {!presentationTarget && askButton}
        </div>
      </div>
      <p className="captions media-status" role="status">
        <SymbolIcon name={state.microphone ? "mic" : "mic-off"} />
        {statusText(room, state, joining)}
      </p>
      <div aria-live="polite" className="meeting-transcript">
        {captions.question && <p>{captions.question}</p>}
        {captions.reply && (
          <p>
            <strong>{room.member}　</strong>
            {captions.reply}
          </p>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="meeting-controls">
        {presentationTarget
          ? createPortal(
              <>
                {askButton}
                {presentButton}
              </>,
              presentationTarget,
            )
          : presentButton}

        {!joining && !state.connected && !state.reconnecting ? (
          <button className="btn primary mini-call-control" onClick={join}>
            通話に再接続
          </button>
        ) : (
          <>
            {state.connected && (
              <>
                <DeviceButton
                  device="mic"
                  on={state.microphone}
                  toggle={() =>
                    void active.current?.microphone(!state.microphone)
                  }
                />
                <DeviceButton
                  device="camera"
                  on={Boolean(state.camera)}
                  disabled={changingCamera}
                  toggle={() => void toggleCamera()}
                />
              </>
            )}
            {state.connected && state.playbackBlocked && (
              <button
                className="btn mini-call-control"
                onClick={() => void active.current?.playAudio()}
              >
                音声を再生
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                const call = active.current;
                reset();
                setError("");
                call?.close();
              }}
            >
              通話を切る
            </button>
          </>
        )}
      </div>
    </>
  );
}
