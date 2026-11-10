"use client";

import Image from "next/image";
import Link from "next/link";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  observeAccount,
  signInWithGoogle,
  signOutOfGoogleSession,
} from "@/client/infrastructure/firebase-auth";
import type {
  AccountState,
  SignInConfig,
} from "@/client/infrastructure/firebase-auth";

export function GoogleSignIn({
  config,
  children,
}: {
  config: SignInConfig;
  children?: (displayName: string | null) => ReactNode;
}) {
  const [account, setAccount] = useState<AccountState>({ status: "checking" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => observeAccount(config, setAccount), [config, attempt]);

  async function changeAccount(signingIn: boolean) {
    setBusy(true);
    setMessage("");
    try {
      if (signingIn) await signInWithGoogle(config);
      else await signOutOfGoogleSession(config);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : null;
      if (code === "auth/popup-blocked") {
        setMessage("ポップアップを許可して、もう一度お試しください。");
      } else if (code !== "auth/popup-closed-by-user") {
        setMessage(
          signingIn
            ? "ログインできませんでした。もう一度お試しください。"
            : "ログアウトできませんでした。もう一度お試しください。",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (children && account.status === "signed-in") {
    return <Fragment key={account.uid}>{children(account.name)}</Fragment>;
  }
  const controls = (
    <div className="sign-in">
      <div aria-live="polite">
        {account.status === "checking" && <p>ログイン状態を確認しています…</p>}
        {account.status === "signed-in" && (
          <p>
            {account.name ? `${account.name} さんでログイン中` : "ログイン中"}
          </p>
        )}
        {account.status === "unverified" && (
          <p>ログイン状態を確認できませんでした。</p>
        )}
      </div>
      {account.status === "signed-out" && (
        <button
          type="button"
          className="google-btn"
          disabled={busy}
          onClick={() => changeAccount(true)}
        >
          <Image
            src="/brand/google-signin.svg"
            alt="Googleでログイン"
            width={180}
            height={40}
            unoptimized
          />
        </button>
      )}
      {account.status === "unverified" && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          再確認する
        </button>
      )}
      {account.status === "signed-in" && (
        <Link href="/rooms" className="btn primary">
          部屋を開く
        </Link>
      )}
      {(account.status === "signed-in" || account.status === "unverified") && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => changeAccount(false)}
        >
          ログアウト
        </button>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
  return children ? (
    <main className="shell form-page">
      <h1>部屋に入るにはログインしてください</h1>
      {controls}
    </main>
  ) : (
    controls
  );
}
