import {
  schedule,
  updatePlan,
  type Agenda,
  type AgendaCommand,
} from "@/server/domain/meeting-agenda";

export type PhaseNote = { partId: string; text: string };
type Room = {
  open: boolean;
  joined: boolean;
  owner: boolean;
  minutes: number;
  agenda: Agenda;
};

export type AgendaTransaction = {
  notes(): Promise<PhaseNote[]>;
  note(id: string): Promise<PhaseNote | null>;
  append(id: string, note: PhaseNote): void;
  save(agenda: Agenda): void;
};

export function agendaAccessError(room: Pick<Room, "open" | "joined">) {
  if (!room.joined) return "not-member" as const;
  if (!room.open) return "closed" as const;
}

export async function accessAgenda(
  room: Room,
  tx: AgendaTransaction,
  now: number,
  since: number | null,
  command?: AgendaCommand,
) {
  const denied = agendaAccessError(room);
  if (denied) return { error: denied } as const;
  const agenda = room.agenda;
  if (command && command.action !== "note") {
    const updated = updatePlan(agenda, command, room.minutes, room.owner, now);
    if (typeof updated === "string") return { error: updated };
    if (updated !== agenda) tx.save(updated);
    return { value: { saved: true } } as const;
  }
  if (command) return appendPhaseNote(agenda, room.minutes, tx, now, command);
  const timeline = schedule(agenda, room.minutes);
  const clock = {
    serverNow: now,
    version: agenda.version,
    planVersion: agenda.planVersion,
  };
  if (since === agenda.version) return { value: clock };
  return {
    value: {
      ...clock,
      startsAt: timeline.startsAt,
      endsAt: timeline.endsAt,
      parts: withPhaseNotes(timeline.parts, await tx.notes()),
    },
  };
}

export function withPhaseNotes<T extends { partId: string }>(
  parts: T[],
  notes: PhaseNote[],
) {
  const rows = parts.map((p) => ({ ...p, notes: [] as string[] }));
  const byId = new Map(rows.map((part) => [part.partId, part]));
  for (const note of notes) byId.get(note.partId)?.notes.push(note.text);
  return rows;
}

export type NoteCommand = Extract<AgendaCommand, { action: "note" }>;
export async function appendPhaseNote(
  agenda: Agenda,
  minutes: number,
  tx: Omit<AgendaTransaction, "notes">,
  now: number,
  command: NoteCommand,
) {
  const timeline = schedule(agenda, minutes);
  const existing = await tx.note(command.id);
  if (existing) {
    return existing.partId === command.partId && existing.text === command.text
      ? ({ value: { saved: true } } as const)
      : ({ error: "agenda-stale" } as const);
  }
  const part = timeline.parts.find((p) => p.partId === command.partId);
  // Notes belong to the selected discussion part even if the clock advanced while typing.
  if (
    !part ||
    part.startsAt === null ||
    part.startsAt > now ||
    part === timeline.parts.at(-1)
  ) {
    return { error: "agenda-stale" } as const;
  }
  tx.append(command.id, { partId: command.partId, text: command.text });
  tx.save({ ...agenda, version: agenda.version + 1 });
  return { value: { saved: true } } as const;
}
