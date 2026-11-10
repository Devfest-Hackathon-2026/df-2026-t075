"use client";

import type { RoomResearch } from "../infrastructure/rooms";
import { ResearchList } from "./research-list";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { SignInConfig } from "../infrastructure/firebase-auth";
import {
  roomRequest,
  RoomRequestError,
  type RoomSummary,
  type RoomVisit,
} from "../infrastructure/rooms";
import { CreateRoomView } from "../preview/create-room";
import { HomeBack, SymbolIcon } from "./blocks";
import { GoogleSignIn } from "./google-sign-in";
import { MemberMeeting, MemberPreflight } from "./member-room-view";
import { PartList } from "./part-list";
import type { Part } from "../preview/samples";
import { RoomEntrances } from "./room-entrances";

function useRoomData<T>(config: SignInConfig, path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    roomRequest<T>(config, path, "GET", undefined, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setError("");
          setData(value);
        }
      },
      (error: RoomRequestError) => {
        if (!controller.signal.aborted) setError(error.message);
      },
    );
    return () => controller.abort();
  }, [config, path, attempt]);
  return {
    data,
    setData,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}

function MemberRoomList({ config }: { config: SignInConfig }) {
  const {
    data: rooms,
    error,
    retry,
  } = useRoomData<RoomSummary[]>(config, "/api/rooms");
  return (
    <main className="shell workspace">
      <HomeBack href="/" />
      <h1>自分の部屋</h1>
      <RoomEntrances />
      <section className="notebook" aria-label="最近の部屋">
        <div className="section-heading">
          <SymbolIcon name="group" />
          <h2>最近の部屋</h2>
        </div>
        {error ? (
          <p role="alert">
            {error}{" "}
            <button className="btn" onClick={retry}>
              再確認する
            </button>
          </p>
        ) : rooms === null ? (
          <p role="status">読み込み中…</p>
        ) : rooms.length === 0 ? (
          <p>作成した部屋と参加した部屋がここに表示されます。</p>
        ) : (
          <ul className="recent-rooms">
            {rooms.map((room) => (
              <li key={room.code}>
                <Link className="panel lift" href={"/r/" + room.code}>
                  {room.topic}
                  <SymbolIcon name="forward" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function NewMemberRoom({ config }: { config: SignInConfig }) {
  const draft = useRef<{ key: string; id: string } | null>(null);
  return (
    <CreateRoomView
      homeHref="/"
      onCreate={async (topic, minutes, member) => {
        const key = JSON.stringify([topic, minutes, member]);
        if (draft.current?.key !== key)
          draft.current = { key, id: crypto.randomUUID() };
        const result = await roomRequest<{ code: string }>(
          config,
          "/api/rooms",
          "POST",
          { roomId: draft.current.id, topic, minutes, member },
        );
        draft.current = null;
        return result.code;
      }}
    />
  );
}

function RoomMembership({
  config,
  code,
  displayName,
}: {
  config: SignInConfig;
  code: string;
  displayName: string | null;
}) {
  const path = "/api/rooms/" + code + "/membership";
  const {
    data: room,
    setData,
    error,
    retry,
  } = useRoomData<RoomVisit>(config, path);
  const [adult, setAdult] = useState(false);
  const [consent, setConsent] = useState(false);
  const [leavingVersion, setLeavingVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function change(join: boolean) {
    if (!room || busy) return;
    if (join && (!adult || !consent)) {
      setMessage("入室には年齢の確認と文字起こしへの同意が必要です。");
      return;
    }
    if (!join) setLeavingVersion(room.version);
    setBusy(true);
    setMessage("");
    try {
      const updated = await roomRequest<RoomVisit>(config, path, "PUT", {
        action: join ? "join" : "leave",
        version: room.version,
        adultConfirmed: adult,
        transcriptionConsent: consent,
      });
      setData(updated);
      setLeavingVersion(null);
      setAdult(false);
      setConsent(false);
    } catch (error) {
      setMessage(
        error instanceof RoomRequestError
          ? error.message
          : "操作を完了できませんでした。",
      );
      if (!(
        error instanceof RoomRequestError && error.code === "voice-disconnect"
      ))
        retry();
    } finally {
      setBusy(false);
    }
  }

  if (error || !room) {
    return (
      <main className="shell form-page">
        <HomeBack href="/" />
        {error ? (
          <div className="panel form-panel">
            <h1>部屋を開けません</h1>
            <p role="alert">{error}</p>
            <button className="btn" onClick={retry}>
              再確認する
            </button>
          </div>
        ) : (
          <p role="status">部屋を読み込んでいます…</p>
        )}
      </main>
    );
  }

  const feedback = message && (
    <p role="alert" className="form-error">
      {message}
    </p>
  );
  const leave = (
    <button className="btn red" disabled={busy} onClick={() => change(false)}>
      <SymbolIcon name="leave" />
      退室する
    </button>
  );
  if (room.joined && (room.leaving || leavingVersion === room.version)) {
    return (
      <main className="shell form-page">
        <h1>退室処理中</h1>
        <HomeBack href="/" />
        <p role="status">
          {busy
            ? "通話の切断を確認しています。"
            : "退室の完了を確認できていません。"}
        </p>
        {feedback}
        <button className="btn" disabled={busy} onClick={() => change(false)}>
          退室を再試行
        </button>
      </main>
    );
  }
  if (!room.open) {
    return (
      <main className="shell form-page">
        <HomeBack href="/" />
        <h1>{room.topic}</h1>
        <section className="panel form-panel">
          <h2>終了した部屋</h2>
          {room.notebookAvailable && (
            <Link className="btn" href={"/rooms/" + room.roomId + "/note"}>
              話し合いのノート
            </Link>
          )}
          {room.joined && leave}
          {feedback}
        </section>
      </main>
    );
  }
  if (room.joined) {
    return (
      <MemberMeeting room={room} displayName={displayName} config={config}>
        {leave}
        {feedback}
      </MemberMeeting>
    );
  }
  return (
    <MemberPreflight room={room} displayName={displayName}>
      {room.notebookAvailable && (
        <Link className="btn" href={"/rooms/" + room.roomId + "/note"}>
          終了後のノート
        </Link>
      )}
      <label className="checkline">
        <input
          type="checkbox"
          checked={adult}
          onChange={(e) => setAdult(e.target.checked)}
        />
        18歳以上です。
      </label>
      <label className="checkline">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        AIが会話を聞き、文字に起こすことに同意します。
      </label>
      {feedback}
      <button
        className="btn primary"
        disabled={busy}
        onClick={() => change(true)}
      >
        {room.version ? "再入室する" : "入室する"} <SymbolIcon name="forward" />
      </button>
    </MemberPreflight>
  );
}

function MemberNotebook({
  config,
  roomId,
}: {
  config: SignInConfig;
  roomId: string;
}) {
  const { data, error, retry } = useRoomData<{
    topic: string;
    parts: Part[];
    research?: RoomResearch[];
  }>(config, "/api/meetings/" + roomId + "/note");
  return (
    <main className="shell note-page">
      <HomeBack href="/" />
      <h1>{data?.topic ?? "話し合いのノート"}</h1>
      {error ? (
        <p role="alert">
          {error}{" "}
          <button className="btn" onClick={retry}>
            再確認する
          </button>
        </p>
      ) : data ? (
        <>
          <PartList parts={data.parts} />
          <ResearchList rows={data.research ?? []} />
        </>
      ) : (
        <p role="status">読み込み中…</p>
      )}
    </main>
  );
}

export type RoomScreen =
  | { view: "note"; roomId: string }
  | { view: "list" | "create" }
  | { view: "visit"; code: string };

export function MemberRooms({
  config,
  screen,
}: {
  config: SignInConfig;
  screen: RoomScreen;
}) {
  return (
    <GoogleSignIn config={config}>
      {(displayName) =>
        screen.view === "note" ? (
          <MemberNotebook
            key={screen.roomId}
            config={config}
            roomId={screen.roomId}
          />
        ) : screen.view === "visit" ? (
          <RoomMembership
            key={screen.code}
            config={config}
            code={screen.code}
            displayName={displayName}
          />
        ) : screen.view === "create" ? (
          <NewMemberRoom config={config} />
        ) : (
          <MemberRoomList config={config} />
        )
      }
    </GoogleSignIn>
  );
}
