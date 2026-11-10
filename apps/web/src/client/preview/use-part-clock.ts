import { useCallback, useState, useEffect } from "react";
import type { PreviewSession } from "./session";
export function usePartClock(
  room: PreviewSession["room"],
  setRoom: PreviewSession["setRoom"],
  onMove: (name: string) => void,
) {
  const [now, setNow] = useState<number | null>(null);

  const until = room.endsAt;
  const part = room.parts[room.partIndex];
  const planning = room.partIndex < 0;
  const last = room.partIndex === room.parts.length - 1;
  const [undo, setUndo] = useState<{
    from: number;
    expires: number;
    previousEnd: number | null;
  } | null>(null);
  useEffect(() => {
    if (room.noteId) return;
    if (planning && until === null) {
      const end = Date.now() + 180000;
      setRoom((old) => ({ ...old, endsAt: old.endsAt ?? end }));
    }
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [planning, until, room.noteId, setRoom]);
  const moveTo = useCallback(
    (index: number, parts = room.parts) => {
      const next = parts[index];
      if (!next) return;
      const time = Date.now();
      setNow(time);

      setRoom((old) => ({
        ...old,
        parts,
        partIndex: index,
        endsAt: time + next.minutes * 60_000,
      }));
      onMove(next.name);
    },
    [room.parts, setRoom, onMove],
  );
  function next() {
    setUndo({
      from: room.partIndex,
      expires: Date.now() + 5000,
      previousEnd: until,
    });
    moveTo(room.partIndex + 1);
  }
  function undoMove() {
    const previous = undo;
    if (previous && Date.now() < previous.expires) {
      moveTo(previous.from);
      setRoom((old) => ({ ...old, endsAt: previous.previousEnd }));
    }
    setUndo(null);
  }
  const duration = part?.minutes ?? 3;
  const seconds =
    until !== null && now !== null
      ? Math.max(0, Math.ceil((until - now) / 1000))
      : duration * 60;
  useEffect(() => {
    if (seconds !== 0 || last || room.noteId) return;
    const timer = window.setTimeout(() => moveTo(room.partIndex + 1), 0);
    return () => clearTimeout(timer);
  }, [seconds, last, room.noteId, room.partIndex, moveTo]);
  function extend() {
    const time = Date.now();
    setNow(time);
    setRoom((old) => ({
      ...old,
      endsAt: (old.endsAt ?? time + duration * 60_000) + 60_000,
    }));
  }
  return {
    now,
    undo,
    next,
    undoMove,
    extend,
    moveTo,
    part,
    planning,
    last,
    seconds,
  };
}
