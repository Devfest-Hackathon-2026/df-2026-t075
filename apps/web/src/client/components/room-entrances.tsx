"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SymbolIcon } from "./blocks";

export function RoomEntrances({ demoCode }: { demoCode?: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [issue, setIssue] = useState("");

  function enter(event: FormEvent) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      setIssue("英数字6文字の招待コードを入力してください。");
      return;
    }
    router.push(
      "/r/" +
        normalized +
        (demoCode && normalized !== demoCode ? "?demo=1" : ""),
    );
  }
  return (
    <section className="entrances" aria-label="部屋の入口">
      <Link
        href={demoCode ? "/rooms/new" : "/rooms/new?mode=live"}
        className="create-entry lift primary"
      >
        <span className="entry-symbol">
          <SymbolIcon name="add" />
        </span>
        <span>
          <strong>部屋を作る</strong>
          <small>お題と時間を決めて、招待リンクを作る</small>
        </span>
        <SymbolIcon name="forward" />
      </Link>
      <form className="join-code panel" onSubmit={enter}>
        <label htmlFor="invite-code">招待コードで入る</label>
        <div className="input-action">
          <input
            aria-describedby="code-help"
            id="invite-code"
            placeholder="英数字6文字"
            value={code}
            maxLength={6}
            onChange={(e) => {
              setCode(e.target.value);
              setIssue("");
            }}
          />
          <button className="btn" type="submit">
            入る
            <SymbolIcon name="forward" />
          </button>
        </div>
        <small id="code-help" aria-live="polite">
          {issue || (demoCode ? "デモ用コード　" + demoCode : "")}
        </small>
      </form>
    </section>
  );
}
