import Link from "next/link";
import type { ReactNode } from "react";

type SymbolName =
  | "hand"
  | "bot"
  | "note"
  | "chat"
  | "search"
  | "discussion-map"
  | "forward"
  | "back"
  | "add"
  | "copy"
  | "mic"
  | "mic-off"
  | "camera"
  | "camera-off"
  | "leave"
  | "menu"
  | "book"
  | "close"
  | "check"
  | "flag"
  | "volume"
  | "timer"
  | "down"
  | "error"
  | "group"
  | "fullscreen"
  | "fullscreen-exit"
  | "move"
  | "outward";
export function SymbolIcon({ name }: { name: SymbolName }) {
  return <span aria-hidden="true" className={"symbol icon-" + name} />;
}
export function DeviceButton({
  device,
  on,
  toggle,
  disabled,
}: {
  device: "mic" | "camera";
  on: boolean;
  toggle: () => void;
  disabled?: boolean;
}) {
  const label =
    (device === "mic" ? "マイク" : "カメラ") +
    (on ? "をオフにする" : "をオンにする");
  return (
    <button
      type="button"
      className={"icon-btn " + (device === "mic" && !on ? "red" : "")}
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={toggle}
    >
      <SymbolIcon
        name={on ? device : device === "mic" ? "mic-off" : "camera-off"}
      />
    </button>
  );
}
export function SiteBar({
  viewer,
  preview = true,
}: {
  viewer?: { name: string; initial: string; color: string };
  preview?: boolean;
}) {
  return (
    <header className="site-bar">
      <div className="bar-inner">
        <Link
          href={viewer ? "/home" : "/"}
          className="wordmark"
          aria-label="AInote ホーム"
        >
          AInote
        </Link>
        <div className="bar-end">
          {preview && <span className="preview-label">デザインプレビュー</span>}
          {viewer && (
            <span
              role="img"
              className={"avatar " + viewer.color}
              aria-label={viewer.name}
            >
              {viewer.initial}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
export function HomeBack({ href = "/home" }: { href?: string }) {
  return (
    <Link href={href} className="back-link">
      <SymbolIcon name="back" />
      ホームへ
    </Link>
  );
}
type Person = { name: string; initial: string; color: string };
export function Participants({
  people,
  member,
}: {
  people: readonly Person[];
  member?: string;
}) {
  return (
    <span
      className="people"
      role="img"
      aria-label={[
        "参加者",
        ...people.map((p) => p.name),
        member && member + "（AI）",
      ]
        .filter(Boolean)
        .join("、")}
    >
      {people.map((p) => (
        <span aria-hidden="true" key={p.name} className={"avatar " + p.color}>
          {p.initial}
        </span>
      ))}
      {member && (
        <span aria-hidden="true" className="avatar blue">
          AI
        </span>
      )}
    </span>
  );
}
export type AiState = "idle" | "listening" | "raised" | "speaking" | "thinking";
export function Face({
  member = "ノト",
  state = "listening",
}: {
  member?: string;
  state?: AiState;
}) {
  return (
    <span
      aria-hidden="true"
      className={
        "face " +
        (member === "ピコ"
          ? "eyes-round"
          : member === "ロロ"
            ? "eyes-narrow"
            : "") +
        " " +
        state
      }
    >
      <span className="eyes">
        <i />
        <i />
      </span>
      <span className="mouth">
        {state === "thinking" && (
          <>
            <i />
            <i />
            <i />
          </>
        )}
      </span>
    </span>
  );
}
export function PersonTile({
  person,
  talking = false,
  muted = false,
  cameraPreview = false,
  children,
}: {
  person: Person;
  talking?: boolean;
  muted?: boolean;
  cameraPreview?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={
        "tile person-tile " + person.color + (talking ? " talking" : "")
      }
    >
      {children ??
        (cameraPreview ? (
          <span className="camera-sample">
            <SymbolIcon name="camera" />
            <small>カメラ表示の見本</small>
          </span>
        ) : (
          <span className="initial" aria-hidden="true">
            {person.initial}
          </span>
        ))}
      <span className="tile-label">
        <span className="tile-name">{person.name}</span>
        {muted && <SymbolIcon name="mic-off" />}
      </span>
    </div>
  );
}
export function SelfTile({
  displayName,
  muted = true,
  children,
}: {
  displayName: string | null;
  muted?: boolean;
  children?: ReactNode;
}) {
  const name = displayName?.trim();
  return (
    <PersonTile
      person={{
        name: name ? name + "（あなた）" : "あなた",
        initial: name ? Array.from(name)[0]!.toLocaleUpperCase("ja") : "自",
        color: "butter",
      }}
      muted={muted}
    >
      {children}
    </PersonTile>
  );
}

export function AiTile({
  researching = false,
  member = "ノト",
  state = "listening",
}: {
  member?: string;
  state?: AiState;
  researching?: boolean;
}) {
  return (
    <div className={"tile ai-tile " + (state === "speaking" ? "talking" : "")}>
      <Face member={member} state={state} />
      <span className="tile-label">
        {member}
        <b>AI</b>
      </span>
      {state === "raised" && (
        <span className="hand-block" role="img" aria-label="挙手中">
          <SymbolIcon name="hand" />
        </span>
      )}
      {researching && (state === "listening" || state === "raised") ? (
        <span className="ai-status">調べています</span>
      ) : (
        state === "thinking" && <span className="ai-status">考えています</span>
      )}
      {state === "idle" && <span className="device-state">未接続</span>}
    </div>
  );
}
export type ErrorKind = "invite" | "age" | "devices" | "page";
const messages: Record<ErrorKind, [string, string, string]> = {
  invite: [
    "招待が使えません",
    "コードが無効か、部屋が終了しています。",
    "主催者に新しい招待リンクを確認してください。",
  ],
  age: [
    "参加条件を満たしていません",
    "このサービスの対象は18歳以上です。",
    "登録した年齢条件を確認してください。",
  ],
  devices: [
    "マイクとカメラが使えません",
    "ブラウザでデバイスの利用が許可されていません。",
    "サイト設定でマイクとカメラを許可し、入室前確認を開き直してください。",
  ],
  page: [
    "ページが見つかりません",
    "指定された画面は開けませんでした。",
    "ホームから目的の画面を開いてください。",
  ],
};
export function ProblemScreen({
  kind,
  withHeader = true,
}: {
  kind: ErrorKind;
  withHeader?: boolean;
}) {
  const [title, reason, action] = messages[kind];
  return (
    <>
      {withHeader && <SiteBar />}
      <main className="shell error-page">
        <span className="error-icon">
          <SymbolIcon name="error" />
        </span>
        <h1>{title}</h1>
        <p>
          {reason}
          <br />
          {action}
        </p>
        <Link className="btn primary" href="/home">
          ホームへ
          <SymbolIcon name="forward" />
        </Link>
      </main>
    </>
  );
}
