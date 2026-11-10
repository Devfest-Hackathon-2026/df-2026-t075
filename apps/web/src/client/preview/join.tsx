"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  DeviceButton,
  Face,
  Participants,
  PersonTile,
  ProblemScreen,
  SymbolIcon,
} from "../components/blocks";
import { JoinLayout } from "../components/room-layout";
import { people, roomPath } from "./samples";
import { usePreview } from "./session";

export function JoinRoom() {
  const { room, setRoom } = usePreview();
  const router = useRouter();
  if (room.noteId) return <ProblemScreen kind="invite" withHeader={false} />;
  function enter(camera: boolean, mic: boolean) {
    const query = new URLSearchParams();
    if (camera) query.set("camera", "on");
    if (!mic) query.set("mic", "off");
    const enteredAt = Date.now();
    setRoom((old) => ({
      ...old,
      endsAt: old.endsAt ?? enteredAt + 180000,
      left: false,
    }));
    router.push(query.size ? roomPath + "?" + query : roomPath);
  }
  return <JoinView room={room} onEnter={enter} />;
}
export function JoinView({
  room,
  onEnter,
}: {
  room: ReturnType<typeof usePreview>["room"];
  onEnter: (camera: boolean, mic: boolean) => void;
}) {
  const [mic, setMic] = useState(true),
    [camera, setCamera] = useState(false);
  const [agreed, setAgreed] = useState(false),
    [error, setError] = useState(false);
  function join() {
    if (!agreed) {
      setError(true);
      return;
    }
    onEnter(camera, mic);
  }
  return (
    <JoinLayout>
      <section className="panel devices">
        <h2>マイクとカメラ</h2>
        <div className="device-preview">
          <PersonTile person={people[2]} muted={!mic} cameraPreview={camera} />
          {!camera && <span className="device-state">カメラはオフ</span>}
        </div>
        <div className="device-controls">
          <DeviceButton device="mic" on={mic} toggle={() => setMic(!mic)} />
          <DeviceButton
            device="camera"
            on={camera}
            toggle={() => setCamera(!camera)}
          />
          <span className="level" role="img" aria-label="音量の見本">
            {Array.from({ length: 7 }, (_, i) => (
              <i key={i} className={mic && i < 4 ? "lit" : ""} />
            ))}
          </span>
        </div>
        <div className="device-select">
          <label className="field">
            マイク
            <select>
              <option>標準のマイク</option>
            </select>
          </label>
          <label className="field">
            カメラ
            <select>
              <option>標準のカメラ</option>
            </select>
          </label>
        </div>
        <label className="checkline">
          <input
            type="checkbox"
            checked={!camera}
            onChange={(e) => setCamera(!e.target.checked)}
          />
          カメラなしで参加する
        </label>
        <small className="meta">
          プレビュー用の表示です。端末のマイクやカメラは使用しません。
        </small>
      </section>
      <section className="join-summary">
        <div className="panel room-info">
          <h2>{room.topic}</h2>
          <p className="meta">主催　ユイ　·　{room.minutes}分</p>
          <div className="waiting">
            <Participants people={people} />
            <Face member={room.member} />
            <small>参加予定のメンバー</small>
          </div>
        </div>
        <div className="panel blue ai-info">
          <Face member={room.member} />
          <div>
            <h3>
              {room.member} <span>AI</span>
            </h3>
            <p>会話を聞き、話す順番とパートごとのメモを受け持ちます。</p>
          </div>
        </div>
        <label className="checkline">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => {
              setAgreed(e.target.checked);
              setError(false);
            }}
          />
          AIが会話を聞き、文字に起こすことに同意します。
        </label>
        {error && (
          <p role="alert" className="form-error">
            入室には同意が必要です。内容を確認してチェックしてください。
          </p>
        )}
        <button type="button" onClick={join} className="btn primary">
          入室する
          <SymbolIcon name="forward" />
        </button>
        <small className="meta">入室すると、AIの声の再生も許可されます。</small>
      </section>
    </JoinLayout>
  );
}
