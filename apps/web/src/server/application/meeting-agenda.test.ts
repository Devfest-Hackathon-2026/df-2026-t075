import { expect, it, vi } from "vitest";
import {
  initialAgenda,
  type Agenda,
  type AgendaCommand,
} from "@/server/domain/meeting-agenda";
import { accessAgenda, type PhaseNote } from "./meeting-agenda";

function roomState(agenda?: Agenda) {
  const room = {
    open: true,
    joined: true,
    owner: true,
    minutes: 15,
    agenda: agenda ?? initialAgenda(15),
  };
  const notes = new Map<string, PhaseNote>();
  const readNotes = vi.fn(async () => [...notes.values()]);
  async function transact(
    now: number,
    since: number | null,
    command?: AgendaCommand,
    overrides: Partial<typeof room> = {},
  ) {
    const pendingNotes = new Map<string, PhaseNote>();
    let pendingAgenda = room.agenda;
    const result = await accessAgenda(
      { ...room, ...overrides },
      {
        notes: readNotes,
        note: async (id) => notes.get(id) ?? null,
        append: (id, value) => {
          pendingNotes.set(id, value);
        },
        save: (value) => {
          pendingAgenda = value;
        },
      },
      now,
      since,
      command,
    );
    if ("value" in result) {
      room.agenda = pendingAgenda;
      for (const [id, note] of pendingNotes) notes.set(id, note);
    }
    return result;
  }
  return { room, transact, readNotes, notes };
}

it("checks membership on every read and write, including version-only polling", async () => {
  const { room, transact, readNotes } = roomState();
  expect(await transact(20, 0, undefined, { joined: false })).toEqual({
    error: "not-member",
  });
  expect(
    await transact(20, null, { action: "start" }, { open: false }),
  ).toEqual({ error: "closed" });
  expect(
    await transact(20, null, { action: "start" }, { owner: false }),
  ).toEqual({ error: "host-only" });
  expect(await transact(20, 0)).toEqual({
    value: { serverNow: 20, version: 0, planVersion: 0 },
  });
  expect(readNotes).not.toHaveBeenCalled();
  const start = transact(20, null, { action: "start" });
  // save() has staged the new plan; readers still see the committed plan.
  expect(room.agenda.planningAt).toBeNull();
  await start;
  expect(room.agenda.planningAt).toBe(20);
  await transact(21, null, { action: "start" });
  expect(room.agenda.planningAt).toBe(20);
});

it("keeps notes in their named phases, including retries after a phase boundary", async () => {
  const { room, transact, notes } = roomState({
    ...initialAgenda(15),
    planningAt: 0,
    confirmedAt: 1000,
    version: 2,
  });
  const note = {
    action: "note",
    id: "a",
    partId: "part-0",
    text: "金曜日に集まる",
  } as const;
  for (const command of [
    { ...note, partId: "part-4" },
    { ...note, partId: "part-1" },
  ]) {
    expect(await transact(2000, null, command)).toEqual({
      error: "agenda-stale",
    });
  }
  expect(await transact(999, null, note)).toEqual({
    error: "agenda-stale",
  });
  expect(await transact(901000, null, { ...note, partId: "part-3" })).toEqual({
    error: "agenda-stale",
  });
  await transact(2000, null, note);
  await transact(301000, null, note);
  await transact(301000, null, {
    ...note,
    id: "b",
    partId: "part-1",
    text: "候補を二つ選ぶ",
  });
  expect(notes.size).toBe(2);
  expect(room.agenda.version).toBe(4);
  expect(await transact(301000, null, { ...note, text: "別の項目" })).toEqual({
    error: "agenda-stale",
  });
  const result = await transact(301000, null);
  expect(result.value).toMatchObject({
    startsAt: 1000,
    endsAt: 901000,
    parts: [
      { notes: [note.text] },
      { notes: ["候補を二つ選ぶ"] },
      { notes: [] },
      { notes: [] },
    ],
  });
});
