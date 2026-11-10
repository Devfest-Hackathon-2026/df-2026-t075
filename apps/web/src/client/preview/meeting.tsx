"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  AiTile,
  DeviceButton,
  PersonTile,
  SymbolIcon,
  type AiState,
} from "../components/blocks";
import { PartList } from "../components/part-list";
import { MeetingHeader } from "../components/room-layout";
import { Dialog, InviteDialog } from "./dialog";
import { people, reflections } from "./samples";
import { usePreview, type PreviewSession } from "./session";
import { usePartClock } from "./use-part-clock";
import { PreviewPlanForm } from "./plan-form";

function secondsText(seconds: number) {
  return (
    String(Math.floor(seconds / 60)) +
    ":" +
    String(seconds % 60).padStart(2, "0")
  );
}

type MeetingProps = { muted?: boolean; cameraOn?: boolean; notice: string };
export function Meeting(props: MeetingProps) {
  const session = usePreview();
  return (
    <MeetingView
      {...props}
      room={session.room}
      setRoom={session.setRoom}
      finishRoom={session.finishRoom}
    />
  );
}
export function MeetingView({
  muted = false,
  cameraOn = false,
  notice,
  room,
  setRoom,
  finishRoom,
}: MeetingProps & Pick<PreviewSession, "room" | "setRoom" | "finishRoom">) {
  const router = useRouter();
  const [panel, setPanel] = useState(true),
    [mic, setMic] = useState(!muted),
    [camera, setCamera] = useState(cameraOn);
  const [modal, setModal] = useState<
    "invite" | "menu" | "signal" | "finish" | null
  >(null);
  const [signal, setSignal] = useState(""),
    [entry, setEntry] = useState("");
  const [aiState, setAiState] = useState<AiState>("raised");
  const [caption, setCaption] = useState(
    "進め方はどうしますか？　まずは、今日話したいことを持ち寄りましょう。",
  );
  const aiStopped = notice === "offline";
  const onMove = useCallback((name: string) => {
    setEntry("");
    setCaption("「" + name + "」を始めましょう。");
    setAiState("listening");
  }, []);
  const { now, undo, next, undoMove, extend, moveTo, planning, last, seconds } =
    usePartClock(room, setRoom, onMove);
  useEffect(() => {
    if (!signal) return;
    const t = window.setTimeout(() => setSignal(""), 3200);
    return () => clearTimeout(t);
  }, [signal]);
  useEffect(() => {
    if (aiState === "thinking") {
      const t = window.setTimeout(() => {
        setCaption("ここまでの話に、付け加えたいことはありますか？");
        setAiState("speaking");
      }, 1400);
      return () => clearTimeout(t);
    }
    if (aiState === "speaking") {
      const t = window.setTimeout(() => setAiState("listening"), 3200);
      return () => clearTimeout(t);
    }
  }, [aiState]);
  function finish() {
    router.push("/rooms/" + finishRoom() + "/note");
  }
  function append(event: FormEvent) {
    event.preventDefault();
    const item = entry.trim();
    if (!item) return;
    setRoom((old) => ({
      ...old,
      parts: old.parts.map((p, i) =>
        i === old.partIndex ? { ...p, notes: [...p.notes, item] } : p,
      ),
    }));
    setEntry("");
  }
  if (room.noteId)
    return (
      <main className="shell error-page">
        <h1>この部屋は終了しました</h1>
        <button
          className="btn primary"
          onClick={() => router.push("/rooms/" + room.noteId + "/note")}
        >
          ノートを読む
          <SymbolIcon name="book" />
        </button>
      </main>
    );
  return (
    <main className="meeting shell">
      <MeetingHeader
        topic={room.topic}
        status={
          <>
            {!aiStopped && <i />}
            {aiStopped ? "AIが停止中" : "AIが聞いています"}
          </>
        }
        time={secondsText(seconds)}
      />
      {aiStopped && (
        <div role="status" className="notice red">
          AIが停止しています。話し合いと進行メモは続けられます。
        </div>
      )}
      {notice === "reconnecting" && (
        <div role="status" className="notice">
          再接続しています。しばらくお待ちください。
        </div>
      )}
      <div className={"meeting-body " + (panel ? "with-panel" : "")}>
        <div className="meeting-stage">
          <div className="video-grid">
            {people.map((p, i) => (
              <PersonTile
                key={p.name}
                person={p}
                muted={i === 2 && !mic}
                cameraPreview={i === 2 && camera}
                talking={i === 0 && aiState !== "speaking"}
              />
            ))}
            <div className="ai-wrap">
              <AiTile
                member={room.member}
                state={aiStopped ? "listening" : aiState}
              />
              {aiState === "raised" && !aiStopped && (
                <button
                  className="btn allow-ai"
                  onClick={() => {
                    setAiState("speaking");
                    setCaption(
                      planning
                        ? "どんな順番で話したいですか？"
                        : "ここまでの話に、付け加えたいことはありますか？",
                    );
                  }}
                >
                  どうぞ
                </button>
              )}
              {aiState === "listening" && !aiStopped && (
                <button
                  className="btn allow-ai"
                  onClick={() => setAiState("thinking")}
                >
                  話しかける
                </button>
              )}
            </div>
          </div>
          <div className="captions" aria-live="polite">
            <b>{room.member} · AI</b>
            <span>{aiStopped ? "字幕を一時停止しています。" : caption}</span>
          </div>
          <div className="personal-status" role="status">
            {signal && <span className="chip yellow">{signal}</span>}
          </div>
          <div className="meeting-controls">
            <DeviceButton
              device="mic"
              on={mic}
              toggle={() => {
                setMic(!mic);
                if (!mic) setAiState("listening");
              }}
            />
            <DeviceButton
              device="camera"
              on={camera}
              toggle={() => setCamera(!camera)}
            />
            <button
              className="icon-btn"
              title="AIに合図を送る"
              aria-label="AIに合図を送る"
              onClick={() => setModal("signal")}
            >
              <SymbolIcon name="flag" />
            </button>
            <button
              className="icon-btn"
              title="その他の操作"
              aria-label="その他の操作"
              onClick={() => setModal("menu")}
            >
              <SymbolIcon name="menu" />
            </button>
            <button
              className="btn red"
              onClick={() => {
                setRoom((old) => ({ ...old, left: true }));
                router.push("/home");
              }}
            >
              <SymbolIcon name="leave" />
              退室
            </button>
          </div>
        </div>
        {panel ? (
          <aside className="agenda panel">
            <div className="agenda-heading">
              <h2>進行メモ</h2>
              <button
                className="flat-icon"
                aria-label="進行メモを閉じる"
                title="進行メモを閉じる"
                onClick={() => setPanel(false)}
              >
                <SymbolIcon name="close" />
              </button>
            </div>
            {planning ? (
              <PreviewPlanForm
                parts={room.parts}
                minutes={room.minutes}
                save={(parts) => setRoom((old) => ({ ...old, parts }))}
                start={(parts) => moveTo(0, parts)}
              />
            ) : (
              <>
                <PartList parts={room.parts} current={room.partIndex} />
                {last ? (
                  <div className="reflection">
                    <h3>言いたいことを話せましたか？</h3>
                    {reflections.map((r, i) => (
                      <button
                        key={r}
                        aria-pressed={room.reflection === r}
                        className={
                          "btn " +
                          (i === 0 ? "green" : "") +
                          (r === room.reflection ? " chosen" : "")
                        }
                        onClick={() =>
                          setRoom((old) => ({ ...old, reflection: r }))
                        }
                      >
                        {r}
                      </button>
                    ))}
                    <button className="btn primary" onClick={finish}>
                      部屋を終える
                    </button>
                  </div>
                ) : (
                  <>
                    <form className="add-note" onSubmit={append}>
                      <label className="field">
                        メモを書き足す
                        <input
                          value={entry}
                          maxLength={180}
                          onChange={(e) => setEntry(e.target.value)}
                        />
                      </label>
                      <button className="small-action" disabled={!entry.trim()}>
                        <SymbolIcon name="add" />
                        追記する
                      </button>
                    </form>
                    <div className="part-actions">
                      <button
                        className="btn"
                        onClick={() => {
                          extend();
                          setSignal("1分延長しました");
                        }}
                      >
                        1分延長
                      </button>
                      <button className="btn primary" onClick={next}>
                        次へ
                        <SymbolIcon name="forward" />
                      </button>
                    </div>
                  </>
                )}
                {undo && now !== null && now < undo.expires && (
                  <button className="small-action" onClick={undoMove}>
                    パート移動を取り消す
                  </button>
                )}
              </>
            )}
          </aside>
        ) : (
          <button className="btn show-agenda" onClick={() => setPanel(true)}>
            <SymbolIcon name="note" />
            進行メモを開く
          </button>
        )}
      </div>
      {modal === "invite" && <InviteDialog onClose={() => setModal(null)} />}
      {modal === "menu" && (
        <Dialog title="部屋の操作" onClose={() => setModal(null)}>
          <div className="dialog-options">
            <button className="btn" onClick={() => setModal("invite")}>
              招待リンクを開く
            </button>
            <button className="btn red" onClick={() => setModal("finish")}>
              部屋を終える
            </button>
          </div>
        </Dialog>
      )}
      {modal === "finish" && (
        <Dialog title="部屋を終えますか？" onClose={() => setModal(null)}>
          <p>ここまでの進め方とメモをノートで読めます。</p>
          <div className="actions end">
            <button className="btn" onClick={() => setModal(null)}>
              戻る
            </button>
            <button className="btn red" onClick={finish}>
              終えてノートを読む
            </button>
          </div>
        </Dialog>
      )}
      {modal === "signal" && (
        <Dialog title="AIに合図を送る" onClose={() => setModal(null)}>
          <p>伝えたい合図を選んでください。</p>
          <div className="dialog-options">
            {["話したい", "時間が気になる", "話が逸れている"].map((s) => (
              <button
                className="btn"
                key={s}
                onClick={() => {
                  setSignal("合図を選びました：" + s);
                  setAiState("raised");
                  setModal(null);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </main>
  );
}
