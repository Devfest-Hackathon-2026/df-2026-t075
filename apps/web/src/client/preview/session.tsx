"use client";

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  sampleParts,
  type Part,
  type Preset,
  type Reflection,
  type SampleNote,
} from "./samples";

type PreviewRoom = {
  topic: string;
  minutes: number;
  member: Preset;
  parts: Part[];
  partIndex: number;
  endsAt: number | null;
  left: boolean;
  noteId: string | null;
  reflection?: Reflection;
};

export function makePreviewRoom(
  topic: string,
  minutes: number,
  member: Preset,
): PreviewRoom {
  return {
    topic,
    minutes,
    member,
    parts: sampleParts(minutes),
    partIndex: -1,
    endsAt: null,
    left: false,
    noteId: null,
  };
}

export type PreviewSession = {
  room: PreviewRoom;
  notes: SampleNote[];
  finishRoom: () => string;
  setRoom: Dispatch<SetStateAction<PreviewRoom>>;
};
const Session = createContext<PreviewSession | null>(null);

// State belongs to this preview tab and expires on reload.
export function PreviewProvider({ children }: { children: ReactNode }) {
  const [room, setRoom] = useState(() =>
    makePreviewRoom("ゼミ合宿の企画を考える", 30, "ノト"),
  );
  const [notes, setNotes] = useState<SampleNote[]>([]);
  function finishRoom() {
    if (room.noteId) return room.noteId;
    const id = `preview-${notes.length + 1}`;
    const date = new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(new Date())
      .replaceAll("/", ".");
    const note: SampleNote = {
      id,
      member: room.member,
      topic: room.topic,
      date,
      role: "主催",
      parts: room.parts,
      ...(room.reflection ? { reflection: room.reflection } : {}),
    };
    setNotes((previous) => [note, ...previous]);
    setRoom((previous) => ({ ...previous, noteId: id, left: false }));
    return id;
  }
  return (
    <Session.Provider value={{ room, setRoom, notes, finishRoom }}>
      {children}
    </Session.Provider>
  );
}

export function usePreview() {
  const session = useContext(Session);
  if (!session) throw new Error("PreviewProvider is required");
  return session;
}
