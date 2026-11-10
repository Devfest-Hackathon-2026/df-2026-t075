"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { SymbolIcon } from "../components/blocks";
import { inviteCode, roomPath } from "./samples";

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const label = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={label}
      onCancel={onClose}
      className="dialog"
    >
      <div className="dialog-heading">
        <h2 id={label}>{title}</h2>
        <button
          className="icon-btn"
          aria-label="閉じる"
          title="閉じる"
          onClick={onClose}
        >
          <SymbolIcon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Copy({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }
  return (
    <span className="copy-control">
      <button type="button" className="btn" onClick={copy}>
        <SymbolIcon name="copy" />
        {label}
      </button>
      <span role="status">
        {status === "copied" ? (
          <span className="chip green">コピーしました</span>
        ) : status === "failed" ? (
          "コピーできませんでした。文字を選択してコピーしてください。"
        ) : null}
      </span>
    </span>
  );
}
export function InviteLink({
  url,
  copyLabel = "リンクをコピー",
}: {
  url: string;
  copyLabel?: string;
}) {
  return (
    <>
      <label className="field">
        招待リンク
        <input
          readOnly
          value={url}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <Copy text={url} label={copyLabel} />
    </>
  );
}
export function InviteDialog({
  onClose,
  created = false,
  code,
}: {
  onClose: () => void;
  created?: boolean;
  code?: string;
}) {
  const path = "/r/" + (code ?? inviteCode);
  const url = window.location.origin + path;
  return (
    <Dialog
      title={created ? "部屋ができました" : "招待リンク"}
      onClose={onClose}
    >
      {!code && (
        <p>
          このタブで作った部屋に入れます。別のタブでリンクを開くと、サンプルの部屋が表示されます。
        </p>
      )}
      <InviteLink url={url} />
      <p className="meta">
        {code ? "招待コード" : "デモ用の招待コード"}　
        <strong>{code ?? inviteCode}</strong>
      </p>
      <div className="actions end">
        {created ? (
          <>
            <Link href={code ? "/rooms" : "/home"} className="btn">
              あとで
            </Link>
            <Link
              href={code ? path : roomPath + "/join"}
              className="btn primary"
            >
              部屋に入る
              <SymbolIcon name="forward" />
            </Link>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            閉じる
          </button>
        )}
      </div>
    </Dialog>
  );
}
