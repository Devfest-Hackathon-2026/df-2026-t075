"use client";

import { useEffect, useState, type ReactNode } from "react";
import { DiscussionMap } from "../discussion-map/discussion-map";
import {
  getSpeakerColors,
  SpeakerBadge,
} from "../discussion-map/speaker-badge";
import { SymbolIcon } from "../components/blocks";
import {
  demoSessionKey,
  useRoomSession,
  type RoomSession,
  type Turn,
} from "./use-room-session";
import "./room.css";

const labels: Record<Turn["state"], string> = {
  recognizing: "文字起こし中",
  queued: "判定待ち",
  mapping: "判定中",
  mapped: "反映済み",
  failed: "判定を一時停止",
  skipped: "判定をスキップ",
  unheard: "聞き取れませんでした",
  "speech-error": "文字起こしに失敗しました。文字でも発言できます。",
};
export function LiveMapRoom() {
  const session = useRoomSession();
  const [mode, setMode] = useState<"loading" | "host" | "guest" | "offline">(
    "loading",
  );
  const [name, setName] = useState(""),
    [consent, setConsent] = useState(false);
  const [guestKey, setGuestKey] = useState(""),
    [tunneled, setTunneled] = useState(false),
    [localLink, setLocalLink] = useState(false);
  useEffect(() => {
    const ac = new AbortController(),
      fragment = location.hash.slice(1);
    void fetch("/live-map/info", { signal: ac.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const info = await r.json();
        if (ac.signal.aborted) return;
        if (sessionStorage.getItem(demoSessionKey + "-invite") !== fragment)
          sessionStorage.removeItem(demoSessionKey);
        setGuestKey(fragment);
        setTunneled(info.tunneled === true);
        setMode(info.host ? "host" : "guest");
      })
      .catch(() => {
        if (!ac.signal.aborted) {
          setLocalLink(["127.0.0.1", "localhost"].includes(location.hostname));
          setMode("offline");
        }
      });
    return () => ac.abort();
  }, []);
  const resume =
    mode !== "loading" ? sessionStorage.getItem(demoSessionKey) : null;
  const { connecting } = session;
  function enter(reconnect = false) {
    setConsent(false);
    void session.connect(
      reconnect && resume
        ? { type: "resume", token: resume }
        : {
            type: mode === "host" ? "create" : "join",
            name: name.trim(),
            consent,
            invite: guestKey,
          },
    );
  }
  return (
    <main className="shell live-map-page" aria-label="ライブ議論マップ">
      <header className="live-heading">
        <div>
          <span className="live-kicker">AInote / 会話デモ</span>
          <h1>ライブ議論マップ</h1>
        </div>
        {session.welcome && (
          <span className="live-indicator">
            ●　{session.mic ? "AIが聞いています" : "入室中・自分のマイクはオフ"}
          </span>
        )}
      </header>
      <SessionMessages session={session} />
      {session.welcome ? (
        <ConnectedMap session={session} demo />
      ) : (
        <section className="panel live-entry">
          {mode === "loading" ? (
            <p>接続先を確認中…</p>
          ) : mode === "offline" ? (
            <>
              <h2>デモ専用の部屋を開いてください</h2>
              <p>主催者から届いた招待リンクで参加できます。</p>
              {localLink && (
                <a className="btn" href="http://127.0.0.1:3117/demo/map/live">
                  このMacで主催する
                </a>
              )}
            </>
          ) : (
            <>
              <h2>
                {mode === "host"
                  ? "話し合いを始める"
                  : "招待された話し合いに入る"}
              </h2>
              <p>
                声で会話すると、発言者ごとの字幕と議論マップを全員で見られます。
              </p>
              {resume ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={connecting}
                  onClick={() => enter(true)}
                >
                  再接続
                </button>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    enter();
                  }}
                >
                  <label>
                    表示名
                    <input
                      required
                      value={name}
                      maxLength={24}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="会話で呼ばれる名前"
                    />
                  </label>
                  <label className="live-consent">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />{" "}
                    <span>
                      18歳以上です。マイクをオンにすると声が参加者に届き、Google
                      Cloudで文字起こしとAI判定が行われることに同意します。入力した発言も共有・判定されます。
                      {tunneled &&
                        " 別のPCとの通信にはCloudflareの一時接続を使います。"}
                    </span>
                  </label>
                  <small>
                    音声は録音として保存しません。字幕とマップは部屋の終了時に消去します。4人・30分まで。
                  </small>
                  {mode === "guest" && !guestKey && (
                    <p>
                      主催者がコピーした招待リンクをそのまま開いてください。
                    </p>
                  )}
                  <button
                    className="btn primary"
                    disabled={
                      !name.trim() ||
                      !consent ||
                      connecting ||
                      (mode === "guest" && !guestKey)
                    }
                  >
                    {connecting
                      ? "接続中…"
                      : mode === "host"
                        ? "デモの部屋を作る"
                        : "入室する"}{" "}
                    <SymbolIcon name="forward" />
                  </button>
                </form>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
function SessionMessages({ session }: { session: RoomSession }) {
  return (
    <>
      {session.notice && (
        <p role="status" className="live-message">
          {session.notice}
        </p>
      )}
      {session.error && (
        <p role="alert" className="live-message live-error">
          {session.error}
        </p>
      )}
    </>
  );
}
export function MemberMapPanel({
  session,
  expanded,
  fullscreenButton,
  researchTools,
}: {
  session: RoomSession;
  expanded: boolean;
  fullscreenButton: ReactNode;
  researchTools: ReactNode;
}) {
  const [showTools, setShowTools] = useState(false);
  return (
    <section className="live-map-page member-map" aria-label="ライブ議論マップ">
      <header className="live-heading">
        <h2>ライブ議論マップ</h2>
        <div className="map-view-actions">
          {expanded &&
            session.welcome &&
            session.state.mappingEnabled !== false && (
              <button
                type="button"
                className="small-action"
                aria-expanded={showTools}
                onClick={() => setShowTools(!showTools)}
              >
                {showTools ? "字幕・操作を閉じる" : "字幕・操作"}
              </button>
            )}
          {fullscreenButton}
        </div>
        {researchTools}
      </header>
      {session.welcome ? (
        <ConnectedMap session={session} hideTools={expanded && !showTools} />
      ) : (
        <p role="status">
          {session.connecting
            ? "議論マップに接続しています…"
            : "議論マップは未接続です。"}
        </p>
      )}
    </section>
  );
}
function ConnectedMap({
  session,
  demo = false,
  hideTools = false,
}: {
  session: RoomSession;
  demo?: boolean;
  hideTools?: boolean;
}) {
  const {
    welcome,
    state,
    send,
    mic,
    micBusy,
    toggleMic,
    playAudio,
    setNotice,
  } = session;
  const [text, setText] = useState(""),
    [confirmEnd, setConfirmEnd] = useState(false),
    [selected, setSelected] = useState("");
  const colors = getSpeakerColors(
    state.members
      .map((p) => ({ id: "", speaker: p.name, text: "" }))
      .concat(state.turns),
  );
  const failed = state.turns.find((t) => t.state === "failed"),
    last = state.turns.at(-1);
  const mapped = [...state.turns].reverse().find((t) => t.state === "mapped");

  if (!welcome) return null;
  if (state.mappingEnabled === false)
    return (
      <div className="panel live-controls">
        <p role="status">
          字幕とマップの共有は終了しました。通話は続けられます。
        </p>
        {welcome.host && (
          <button className="btn" onClick={() => send({ type: "start-map" })}>
            新しいマップを開始
          </button>
        )}
      </div>
    );
  return (
    <>
      <section
        className="panel live-controls"
        hidden={hideTools}
        aria-label={demo ? "話し合いの操作" : "議論マップの操作"}
      >
        {demo && (
          <>
            <div className="live-line">
              <div>
                <h2>参加者</h2>
                <div className="live-people">
                  {state.members.map((p) => (
                    <span key={p.name}>
                      <SpeakerBadge name={p.name} colors={colors} />{" "}
                      {p.name === welcome.name ? "（自分）" : ""}
                      {p.connected ? (p.mic ? " マイクON" : "") : "再接続待ち"}
                    </span>
                  ))}
                </div>
              </div>
              {welcome.host &&
                !welcome.inviteUrl &&
                (welcome.sharing === "failed" ? (
                  <div>
                    <p>招待リンクを作れませんでした。</p>
                    <button
                      className="btn"
                      onClick={() => send({ type: "share" })}
                    >
                      招待リンクを再発行
                    </button>
                  </div>
                ) : (
                  <p role="status">別のPCから入れる招待リンクを準備中…</p>
                ))}
              {welcome.inviteUrl && (
                <details>
                  <summary>メンバーを招待</summary>
                  <label>
                    招待リンク
                    <input
                      readOnly
                      value={welcome.inviteUrl}
                      onFocus={(e) => e.target.select()}
                    />
                  </label>
                  <button
                    className="btn"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(welcome.inviteUrl!)
                        .then(
                          () => setNotice("招待リンクをコピーしました。"),
                          () =>
                            setNotice("招待リンクを選んでコピーしてください。"),
                        )
                    }
                  >
                    招待リンクをコピー
                  </button>
                </details>
              )}
            </div>

            <p>
              各自の端末でマイクをオンにして話してください。発言が途切れると字幕になり、マップが後から追いつきます。
            </p>
          </>
        )}
        <div className="live-buttons">
          {demo && (
            <>
              <button
                className={"btn " + (mic ? "" : "primary")}
                aria-pressed={mic}
                disabled={micBusy}
                onClick={toggleMic}
              >
                <SymbolIcon name={mic ? "mic-off" : "mic"} />
                {mic ? "マイクをオフ" : "マイクをオン"}
              </button>
              <button className="text-action" onClick={playAudio}>
                音声を再生
              </button>
            </>
          )}
          {welcome.host ? (
            <button
              className="text-action"
              onClick={() => setConfirmEnd(!confirmEnd)}
            >
              {demo ? "部屋を終了" : "マップの共有を終了"}
            </button>
          ) : (
            demo && (
              <button
                className="text-action"
                onClick={() => send({ type: "leave" })}
              >
                退室する
              </button>
            )
          )}
        </div>
        {confirmEnd && (
          <div className="live-line">
            <p>
              {demo
                ? "部屋を終了し、全員の字幕とマップを消去します。"
                : "全員の字幕とマップを消去し、文字起こしを止めます。通話は続きます。"}
            </p>
            <button
              className="btn"
              onClick={() => {
                setConfirmEnd(false);
                setText("");
                setSelected("");
                send({ type: demo ? "end" : "stop-map" });
              }}
            >
              終了して消去
            </button>
          </div>
        )}
        <details>
          <summary>文字で発言する</summary>
          <form
            className="live-text"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) {
                send({ type: "text", text: text.trim() });
                setText("");
              }
            }}
          >
            <label>
              発言
              <input
                maxLength={1000}
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <button className="btn" disabled={!text.trim()}>
              発言を送る
            </button>
          </form>
        </details>
      </section>
      <section
        className="panel live-captions"
        aria-label="会話の字幕"
        hidden={hideTools}
      >
        <div className="live-line">
          <h2>会話の字幕</h2>
          <span role="status">
            {state.waiting
              ? `マップ反映待ち ${state.waiting}件`
              : state.turns.length
                ? "処理待ちなし"
                : "最初の発言を待っています"}
            {mapped?.delayMs !== undefined &&
              ` · 前回 ${(mapped.delayMs / 1000).toFixed(1)}秒`}
          </span>
        </div>
        {last && (
          <p aria-live="polite">
            <SpeakerBadge name={last.speaker} colors={colors} />{" "}
            {last.text || labels[last.state]}
          </p>
        )}
        {state.turns.length > 0 && (
          <details>
            <summary>ここまでの発言（{state.turns.length}件）</summary>
            <ol>
              {state.turns.map((t) => (
                <li key={t.id}>
                  <SpeakerBadge name={t.speaker} colors={colors} /> {t.text}{" "}
                  <small>{labels[t.state]}</small>
                </li>
              ))}
            </ol>
          </details>
        )}
        {failed && (
          <div role="alert">
            <p>
              発言 {failed.id}{" "}
              のマップ判定で一時停止しました。会話と字幕は続けられます。
            </p>
            {welcome.host && (
              <div className="live-buttons">
                <button
                  className="btn"
                  disabled={!state.canRetry}
                  onClick={() => send({ type: "retry", id: failed.id })}
                >
                  この発言を再判定
                </button>
                <button
                  className="text-action"
                  onClick={() => send({ type: "skip", id: failed.id })}
                >
                  この発言を飛ばす
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      {state.graph.nodes.length ? (
        <DiscussionMap
          graph={state.graph}
          utterances={state.turns}
          speakerColors={colors}
          selectedId={selected || state.graph.nodes[0]!.id}
          onSelect={setSelected}
        />
      ) : (
        <div className="panel live-empty">
          <SymbolIcon name="note" />
          <h2>ここに議論のつながりが表示されます</h2>
          <p>「何を決めたいか」「どんな案があるか」を話してみてください。</p>
        </div>
      )}
    </>
  );
}
