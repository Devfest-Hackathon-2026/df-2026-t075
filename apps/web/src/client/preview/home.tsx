"use client";

import Link from "next/link";
import { RoomEntrances } from "../components/room-entrances";
import { Participants, SymbolIcon } from "../components/blocks";
import {
  people,
  inviteCode,
  roomPath,
  sampleNotes,
  type SampleNote,
} from "./samples";
import { usePreview } from "./session";

function NoteCard({ note, index }: { note: SampleNote; index: number }) {
  return (
    <Link className="note-card lift" href={"/rooms/" + note.id + "/note"}>
      <div className={"note-stripe " + ["peach", "mint", "lilac"][index % 3]} />
      <div className="note-card-inner">
        <h3>{note.topic}</h3>
        <p className="meta">
          {note.date}　·　{note.parts.length}パート　·　{note.role}
        </p>
        <ul className="note-excerpt">
          {note.parts
            .flatMap((part) => part.notes)
            .slice(0, 2)
            .map((item, i) => (
              <li key={i}>{item}</li>
            ))}
        </ul>
        <div className="note-card-bottom">
          <Participants people={people} member={note.member ?? "ノト"} />
          <SymbolIcon name="outward" />
        </div>
      </div>
    </Link>
  );
}
export function HomeContent({ firstVisit }: { firstVisit: boolean }) {
  const { room, notes: recent } = usePreview();
  return (
    <HomeView
      resume={room.left && !room.noteId}
      notes={[...recent, ...(firstVisit ? [] : sampleNotes)]}
    />
  );
}
export function HomeView({
  resume,
  notes,
}: {
  resume: boolean;
  notes: SampleNote[];
}) {
  return (
    <main className="shell workspace">
      <h1>ホーム</h1>
      {resume && (
        <div className="return-band">
          <span>
            <SymbolIcon name="timer" />
            参加中の部屋があります
          </span>
          <Link className="btn" href={roomPath + "/join"}>
            戻る →
          </Link>
        </div>
      )}
      <RoomEntrances demoCode={inviteCode} />
      <section className="notebook">
        <div className="section-heading">
          <SymbolIcon name="book" />
          <h2>ノート</h2>
        </div>
        {notes.length > 0 ? (
          <div className="note-grid">
            {notes.map((note, i) => (
              <NoteCard key={note.id} note={note} index={i} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <SymbolIcon name="book" />
            <h3>最初の話し合いを始めましょう</h3>
            <p>話し合いが終わると、進め方とメモがここに残ります。</p>
          </div>
        )}
      </section>
    </main>
  );
}
