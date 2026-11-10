"use client";

import {
  HomeBack,
  Participants,
  ProblemScreen,
  SymbolIcon,
} from "../components/blocks";
import { PartList } from "../components/part-list";
import { Copy } from "./dialog";
import { usePreview } from "./session";
import { people, sampleNotes, type SampleNote } from "./samples";
import Link from "next/link";

export function Note({ id }: { id: string }) {
  const { room, notes } = usePreview();
  const noteId = id === "demo" ? room.noteId : id;
  const note =
    notes.find((item) => item.id === noteId) ??
    sampleNotes.find((item) => item.id === noteId);
  if (!note && id !== "demo")
    return <ProblemScreen kind="page" withHeader={false} />;
  if (!note)
    return (
      <main className="shell form-page">
        <HomeBack />
        <h1>話し合いのノート</h1>
        <div className="empty-state">
          <p>部屋を終えると、進め方とメモをここで読めます。</p>
          <Link href="/rooms/demo" className="btn">
            部屋へ
          </Link>
        </div>
      </main>
    );
  return <NoteView note={note} />;
}
export function NoteView({ note }: { note: SampleNote }) {
  const { topic, date, parts, reflection } = note;
  const content = [
    topic,
    ...parts.map(
      (p) => p.name + "（" + p.minutes + "分）\n" + p.notes.join("\n"),
    ),
  ].join("\n\n");
  return (
    <main className="shell note-page">
      <HomeBack />
      <div className="note-info">
        <div className="section-heading">
          <SymbolIcon name="book" />
          <span>話し合いのノート</span>
        </div>
        <h1>{topic}</h1>
        <p className="meta">
          {date}　·　合計{parts.reduce((n, p) => n + p.minutes, 0)}分　·　
          {parts.length}パート
        </p>
        <div className="note-tools">
          <Participants people={people} member={note.member ?? "ノト"} />
          <Copy text={content} label="メモをコピー" />
        </div>
      </div>
      <PartList parts={parts} />
      <section className="private-note dashed">
        <h2>自分の振り返り</h2>
        <p>
          言いたいことを話せましたか　<strong>{reflection ?? "未回答"}</strong>
        </p>
        <small>自分の発言時間　{note.speaking ?? "未計測"}</small>
      </section>
    </main>
  );
}
