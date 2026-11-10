import type { ReactNode } from "react";
import { HomeBack, SymbolIcon } from "./blocks";

export function JoinLayout({
  homeHref = "/home",
  title = "入室前の確認",
  children,
}: {
  homeHref?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <main className="shell workspace">
      <HomeBack href={homeHref} />
      <h1>{title}</h1>
      <div className="join-grid">{children}</div>
    </main>
  );
}

export function MeetingHeader({
  topic,
  status,
  time,
}: {
  topic: string;
  status: ReactNode;
  time: ReactNode;
}) {
  return (
    <header className="meeting-head">
      <h1>{topic}</h1>
      <span className="listen-chip">{status}</span>
      <span className="clock-chip">
        <SymbolIcon name="timer" />
        {time}
      </span>
    </header>
  );
}
