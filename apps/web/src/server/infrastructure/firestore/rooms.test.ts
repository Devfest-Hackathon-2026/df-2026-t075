import { initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  FieldValue,
  type DocumentReference,
  type DocumentData,
  type DocumentSnapshot,
  type Transaction,
  type Query,
} from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoom, admitRoomVoice, createRoom } from "./rooms";
import {
  appendWorkerNote,
  readRoomNotebook,
  legacyRoomAgenda,
  transactProposal,
  transactResearch,
  roomAgenda,
  readMeetingContext,
} from "./meeting-agenda";
import { issueMapTicket, roomMapAvailable } from "./meeting-map";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));
const project = "demo-meeting-auth";
const db = getFirestore(initializeApp({ projectId: project }, "user-auth"));
const docs = new Map<string, DocumentData>();
const input = {
  roomId: "2495a326-91fe-4a3d-931e-4593f77fabd2",
  topic: "勉強会",
  minutes: 30,
  member: "ノト",
};
const roomPath = "rooms/" + input.roomId;
const code = "AB45CD";

const beforeCommit = vi.fn<() => void>();
beforeEach(() => {
  docs.clear();
  beforeCommit.mockReset();
  const readAll = (...refs: DocumentReference[]) =>
    refs.map((ref) => {
      const data = docs.get(ref.path);
      return {
        exists: data !== undefined,
        get: (key: string) => data?.[key],
      } as DocumentSnapshot;
    });
  vi.spyOn(db, "getAll").mockImplementation(async (...refs) =>
    readAll(...(refs as DocumentReference[])),
  );
  vi.spyOn(db, "runTransaction").mockImplementation(async (fn) => {
    const pending = new Map<string, DocumentData>();
    function requireReadPhase() {
      if (pending.size) throw new Error("Firestore reads must precede writes");
    }
    const write = (ref: DocumentReference, value: DocumentData) => {
      pending.set(ref.path, {
        ...(pending.get(ref.path) ?? docs.get(ref.path)),
        ...value,
        ...(value.createdAt instanceof FieldValue &&
        value.createdAt.isEqual(FieldValue.serverTimestamp())
          ? { createdAt: Date.now() }
          : {}),
      });
    };
    const tx = {
      get: async (ref: DocumentReference | Query) => {
        requireReadPhase();
        if ("path" in ref)
          return { ...readAll(ref)[0], data: () => docs.get(ref.path) };
        const notes = db.collection(roomPath + "/phaseNotes");
        const latest = ref.isEqual(
          notes.orderBy("createdAt", "desc").limit(32),
        );
        expect(latest || ref.isEqual(notes.orderBy("createdAt"))).toBe(true);
        const ordered = [...docs]
          .filter(([path]) => path.startsWith(notes.path + "/"))
          .map(([, data]) => data)
          .sort((a, b) =>
            latest ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
          );
        return {
          docs: (latest ? ordered.slice(0, 32) : ordered).map((data) => ({
            data: () => data,
          })),
        };
      },
      getAll: async (...refs: DocumentReference[]) => {
        requireReadPhase();
        return readAll(...refs);
      },
      create: (ref: DocumentReference, value: DocumentData) => {
        if (docs.has(ref.path) || pending.has(ref.path))
          throw new Error("Already exists");
        write(ref, value);
      },
      set: write,
      update: write,
    };
    const result = await fn(tx as unknown as Transaction);
    if (pending.size) beforeCommit();
    for (const [path, data] of pending) docs.set(path, data);
    return result;
  });
});

function seed() {
  docs.set(roomPath, { ...input, ownerUid: "host", code, status: "open" });
  docs.set("roomInvites/" + code, { roomId: input.roomId });
}

describe("room persistence", () => {
  it("reads the latest 32 notes in chronological order from a read-only snapshot", async () => {
    seed();
    for (let index = 0; index < 40; index++) {
      const time = (index * 13) % 40;
      docs.set(roomPath + "/phaseNotes/" + index, {
        partId: "part-0",
        text: String(time),
        createdAt: time,
      });
    }
    const state = await readMeetingContext(project, input.roomId);
    expect(state?.notes.map((note) => note.text)).toEqual(
      Array.from({ length: 32 }, (_, i) => String(i + 8)),
    );
    expect(db.runTransaction).toHaveBeenCalledWith(expect.any(Function), {
      readOnly: true,
    });
  });

  it("issues a short-lived map ticket for an admitted member on the project's configured relay", async () => {
    seed();
    const member = roomPath + "/members/guest";
    const relay = "roomMapSettings/default";
    const issue = (name: string | null = null) =>
      issueMapTicket(project, input.roomId, {
        uid: "guest",
        displayName: name,
      });
    expect(await issue()).toEqual({ error: "not-member" });
    docs.set(member, { joined: true, voiceLeaving: true, version: 3 });
    expect(await issue()).toEqual({ error: "not-member" });
    docs.set(member, { joined: true, version: 3 });
    docs.set(roomPath, { ownerUid: "host", status: "closed" });
    expect(await issue()).toEqual({ error: "closed" });
    seed();
    expect(await issue()).toEqual({ error: "map-offline" });
    for (const origin of [
      "https://external.example",
      1,
      "http://127.0.0.1:5500",
    ]) {
      vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
      docs.set(relay, { enabled: true, origin, session: "fixture" });
      expect(await issue()).toEqual({ error: "map-offline" });
    }
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8180");
    const local = await issue();
    expect(local.value?.url).toBe("ws://127.0.0.1:5500/live-map/socket");
    expect(docs.get(member)?.mapTicket.name).toBe("参加者");
    const settings = {
      enabled: true,
      origin: "https://map-123.asia-northeast1.run.app",
      session: "fixture",
    };
    docs.set(relay, settings);
    const ticket = (await issue(" ゲスト ")).value!;
    expect(ticket.url).toBe(
      "wss://map-123.asia-northeast1.run.app/live-map/socket",
    );
    expect(docs.get(member)?.mapTicket).toMatchObject({
      name: "ゲスト",
      version: 3,
      session: "fixture",
      hash: createHash("sha256").update(ticket.ticket).digest("hex"),
    });
    expect(
      docs.get(member)?.mapTicket.expiresAt - Date.now(),
    ).toBeLessThanOrEqual(30000);
    expect(ticket.ticket).not.toBe(local.value?.ticket);
    vi.spyOn(Object.getPrototypeOf(db.doc(relay)), "get").mockResolvedValue({
      get: (k: string) => docs.get(relay)?.[k],
    });
    const available = () => roomMapAvailable(project, input.roomId);
    expect(await available()).toBe(true);
    docs.set(relay, { ...settings, roomId: "another-room" });
    expect(await available()).toBe(false);
    expect(await issue()).toEqual({ error: "map-offline" });
    docs.set(relay, { ...settings, roomId: input.roomId });
    expect(await available()).toBe(true);
    expect((await issue()).value?.roomId).toBe(input.roomId);
    docs.set(relay, { ...settings, session: null });
    expect(await available()).toBe(false);
    vi.unstubAllEnvs();
  });
  it("binds media issuance and retryable disconnection to a joined membership version", async () => {
    seed();
    const ticket = () => admitRoomVoice(project, "guest", input.roomId);
    expect(await ticket()).toEqual({ error: "not-member" });
    await accessRoom(project, "guest", code, { join: true, version: 0 });
    expect(await admitRoomVoice(project, "guest", "other-room")).toEqual({
      error: "not-member",
    });
    expect(await ticket()).toEqual({
      value: { version: 1, member: input.member },
    });
    expect(await ticket()).toEqual({
      value: { version: 1, member: input.member },
    });
    const leave = () =>
      accessRoom(project, "guest", code, { join: false, version: 1 });
    expect((await leave()).disconnectVersion).toBe(1);
    expect((await accessRoom(project, "guest", code)).value).toMatchObject({
      joined: true,
      leaving: true,
    });
    expect((await leave()).disconnectVersion).toBe(1);
    expect(await ticket()).toEqual({ error: "not-member" });
    expect(
      (await accessRoom(project, "guest", code, { join: false, version: 1 }, 1))
        .value?.joined,
    ).toBe(false);
    expect((await leave()).disconnectVersion).toBeUndefined();
    expect(await ticket()).toEqual({ error: "not-member" });
    await accessRoom(project, "guest", code, { join: true, version: 2 });
    expect((await leave()).error).toBe("stale");
    expect((await ticket()).value?.version).toBe(3);
    docs.get(roomPath)!.status = "ended";
    expect(await ticket()).toEqual({ error: "closed" });
  });
  it("keeps the shared timetable and phase notes in the joined room", async () => {
    seed();
    const read = () => roomAgenda(project, "host", input.roomId, null);
    expect(await read()).toEqual({ error: "not-member" });
    await accessRoom(project, "host", code, { join: true, version: 0 });
    expect((await read()).value).toMatchObject({ startsAt: null, version: 0 });
    await read();
    expect(docs.get(roomPath)!).not.toHaveProperty("agenda");
    expect(docs.get(roomPath)!).not.toHaveProperty("agendaV3");
    await roomAgenda(project, "host", input.roomId, null, { action: "start" });
    await roomAgenda(project, "host", input.roomId, null, {
      action: "confirm",
      planVersion: 1,
      parts: [
        { partId: "part-0", name: "選書の条件", minutes: 28 },
        { partId: "part-3", name: "振り返り", minutes: 2 },
      ],
    });
    const note = {
      action: "note",
      partId: "part-0",
      id: "1b9c1af7-fb44-4bbc-8ed2-f1c30a0f0621",
      text: "金曜日に集まる",
    } as const;
    await roomAgenda(project, "host", input.roomId, null, note);
    await roomAgenda(project, "host", input.roomId, null, note);
    expect(docs.get(roomPath + "/phaseNotes/" + note.id)).toMatchObject({
      partId: "part-0",
      text: note.text,
    });
    expect((await read()).value).toMatchObject({
      version: 3,
      parts: [{ name: "選書の条件", notes: [note.text] }, { notes: [] }],
    });
    expect(await readMeetingContext(project, input.roomId)).toMatchObject({
      topic: input.topic,
      minutes: 30,
      version: 3,
      currentPartId: "part-0",
      remainingSeconds: expect.any(Number),
      notes: [{ partId: "part-0", text: note.text }],
    });
    expect(await readMeetingContext(project, "missing")).toBeNull();
    await accessRoom(project, "host", code, { join: false, version: 1 });
    expect(await read()).toEqual({ error: "not-member" });
  });
  it("rolls back both a note and its agenda migration on commit failure, then retries once", async () => {
    seed();
    await accessRoom(project, "host", code, { join: true, version: 0 });
    const original = {
      version: 2,
      planningAt: 0,
      confirmedAt: 1,
      parts: [
        { name: "候補", minutes: 10 },
        { name: "振り返り", minutes: 2 },
      ],
    };
    docs.get(roomPath)!.agenda = original;
    const notePath = roomPath + "/phaseNotes/retry";
    const append = () =>
      roomAgenda(project, "host", input.roomId, null, {
        action: "note",
        partId: "legacy-0",
        id: "retry",
        text: "候補を二つ",
      });
    beforeCommit.mockImplementationOnce(() => {
      expect(docs.get(roomPath)!.agenda).toEqual(original);
      expect(docs.get(roomPath)!.agendaV3).toBeUndefined();
      expect(docs.has(notePath)).toBe(false);
      throw new Error("Commit interrupted");
    });
    await expect(append()).rejects.toThrow("Commit interrupted");
    expect(docs.get(roomPath)!.agendaV3).toBeUndefined();
    expect(docs.has(notePath)).toBe(false);
    await append();
    await append();
    expect(
      (await roomAgenda(project, "host", input.roomId, null)).value,
    ).toMatchObject({
      version: 3,
      parts: [{ notes: ["候補を二つ"] }, { notes: [] }],
    });
  });

  it("checks access on the legacy URL without reading notes or migrating the room", async () => {
    seed();
    for (const method of ["GET", "POST"] as const) {
      expect(
        await legacyRoomAgenda(project, "host", input.roomId, method),
      ).toEqual({ error: "not-member" });
    }
    await accessRoom(project, "host", code, { join: true, version: 0 });
    const tx = vi.mocked(db.runTransaction);
    tx.mockClear();
    expect(
      (await legacyRoomAgenda(project, "host", input.roomId, "GET")).value,
    ).toMatchObject({
      parts: [{ name: expect.stringContaining("再読み込み"), notes: [] }],
    });
    expect(
      (await legacyRoomAgenda(project, "host", input.roomId, "POST")).error,
    ).toBe("reload-required");
    docs.get(roomPath)!.status = "ended";
    for (const method of ["GET", "POST"] as const) {
      expect(
        await legacyRoomAgenda(project, "host", input.roomId, method),
      ).toEqual({ error: "closed" });
    }
    expect(tx).not.toHaveBeenCalled();
    expect(docs.get(roomPath)!.agendaV3).toBeUndefined();
  });

  it("assigns legacy IDs before the first reorder and persists them once", async () => {
    seed();
    await accessRoom(project, "host", code, { join: true, version: 0 });
    const parts = [
      { name: "考えを出す", minutes: 8 },
      { name: "候補決め", minutes: 8 },
      { name: "振り返り", minutes: 2 },
    ];
    docs.get(roomPath)!.agenda = {
      parts,
      version: 5,
      planningAt: Date.now(),
      confirmedAt: null,
    };
    const read = () => roomAgenda(project, "host", input.roomId, null);
    const reordered = [
      { ...parts[1]!, name: "候補を選ぶ", partId: "legacy-1" },
      { name: "比較", minutes: 5, partId: null },
      { ...parts[0]!, partId: "legacy-0" },
      { ...parts[2]!, partId: "legacy-2" },
    ];
    expect(
      await roomAgenda(project, "host", input.roomId, null, {
        action: "save",
        planVersion: 5,
        parts: reordered,
      }),
    ).toEqual({ value: { saved: true } });
    const expected = reordered.map((p) => ({
      ...p,
      partId: p.partId ?? "part-0",
    }));
    expect((await read()).value).toMatchObject({ parts: expected, version: 6 });
    expect(docs.get(roomPath)!.agendaV2).toMatchObject({
      version: -1,
      confirmedAt: 0,
      numberedParts: ["legacy-0", "legacy-1", "legacy-2"],
      parts: [{ name: expect.stringContaining("再読み込み") }],
    });
    const persisted = docs.get(roomPath)!.agendaV3;
    await read();
    expect(docs.get(roomPath)!.agendaV3).toBe(persisted);
  });

  it("retires every old write target atomically with a reordered plan", async () => {
    seed();
    await accessRoom(project, "host", code, { join: true, version: 0 });
    const previous = [
      { name: "A", minutes: 1 },
      { name: "B", minutes: 1 },
      { name: "振り返り", minutes: 2 },
    ];
    docs.get(roomPath)!.agenda = {
      version: 1,
      planningAt: Date.now(),
      confirmedAt: null,
      parts: previous,
    };
    const reordered = [1, 0, 2].map((i) => ({
      ...previous[i]!,
      partId: `legacy-${i}`,
    }));
    expect(
      (
        await roomAgenda(project, "host", input.roomId, null, {
          action: "confirm",
          planVersion: 1,
          parts: reordered,
        })
      ).value,
    ).toEqual({ saved: true });
    // These are the old server's guards: started, confirmed, no discussion index.
    expect(docs.get(roomPath)!.agenda).toMatchObject({
      planningAt: 0,
      confirmedAt: 0,
      parts: [{ name: expect.stringContaining("再読み込み") }],
    });
    expect(
      (await legacyRoomAgenda(project, "host", input.roomId, "POST")).error,
    ).toBe("reload-required");
    expect(
      (await legacyRoomAgenda(project, "host", input.roomId, "GET")).value,
    ).toMatchObject({
      parts: [{ name: expect.stringContaining("再読み込み"), notes: [] }],
    });
    const note = {
      action: "note",
      id: "n",
      partId: "legacy-1",
      text: "Bのメモ",
    } as const;
    for (let i = 0; i < 2; i++)
      await roomAgenda(project, "host", input.roomId, null, note);
    expect(
      (await roomAgenda(project, "host", input.roomId, null)).value,
    ).toMatchObject({
      version: 3,
      parts: [
        { name: "B", notes: [note.text] },
        { name: "A", notes: [] },
        { notes: [] },
      ],
    });
  });

  it("imports numbered notes from the order the previous writer saw and preserves fixed IDs", async () => {
    seed();
    await accessRoom(project, "host", code, { join: true, version: 0 });
    docs.get(roomPath)!.agenda = {
      version: 4,
      planningAt: 1,
      confirmedAt: 2,
      nextPartNumber: 8,
      parts: [
        { name: "B", minutes: 1, partId: "legacy-1" },
        { name: "A", minutes: 1, partId: "legacy-0" },
        { name: "振り返り", minutes: 2, partId: "part-7" },
      ],
    };
    docs.set(roomPath + "/phaseNotes/old", {
      part: 0,
      text: "Bのメモ",
      createdAt: 3,
    });
    docs.set(roomPath + "/phaseNotes/with-id", {
      partId: "legacy-0",
      text: "Aのメモ",
      createdAt: 4,
    });
    const read = () => roomAgenda(project, "host", input.roomId, null);
    const expected = {
      parts: [
        { partId: "legacy-1", notes: ["Bのメモ"] },
        { partId: "legacy-0", notes: ["Aのメモ"] },
        { partId: "part-7", notes: [] },
      ],
    };
    expect((await read()).value).toMatchObject(expected);
    expect((await read()).value).toMatchObject(expected);
    expect(docs.get(roomPath)!.agendaV3.nextPartNumber).toBe(8);
  });

  it("recovers rows stripped by an earlier old save without recycling retired IDs", async () => {
    seed();
    await accessRoom(project, "host", code, { join: true, version: 0 });
    docs.get(roomPath)!.agenda = {
      version: 3,
      planningAt: Date.now(),
      confirmedAt: null,
      nextPartNumber: 7,
      parts: [
        { name: "A", minutes: 1 },
        { name: "振り返り", minutes: 2 },
      ],
    };
    const result = await roomAgenda(project, "host", input.roomId, 3);
    expect(result.value).toMatchObject({
      parts: [{ partId: "part-7" }, { partId: "part-8" }],
    });
    expect(
      (
        await roomAgenda(project, "host", input.roomId, null, {
          action: "save",
          planVersion: 3,
          parts: [
            { name: "A2", minutes: 1, partId: "part-7" },
            { name: "振り返り", minutes: 2, partId: "part-8" },
          ],
        })
      ).value,
    ).toEqual({ saved: true });
    expect(docs.get(roomPath)!.agendaV3.nextPartNumber).toBe(9);
  });

  it("reads and retries a numbered note on the original started part and rejects removal", async () => {
    seed();
    await accessRoom(project, "host", code, { join: true, version: 0 });
    const parts = [
      { name: "条件", minutes: 3 },
      { name: "候補決め", minutes: 10 },
      { name: "振り返り", minutes: 2 },
    ];
    docs.get(roomPath)!.agenda = {
      parts,
      version: 3,
      planningAt: 1,
      confirmedAt: 2,
    };
    const note = { part: 1, text: "候補は二つ", createdAt: 3 };
    docs.set(roomPath + "/phaseNotes/old", note);
    const read = () => roomAgenda(project, "host", input.roomId, null);
    const expected = {
      parts: [
        { partId: "legacy-0", notes: [] },
        { partId: "legacy-1", name: "候補決め", notes: [note.text] },
        { partId: "legacy-2", notes: [] },
      ],
    };
    expect((await read()).value).toMatchObject(expected);
    expect(
      await roomAgenda(project, "host", input.roomId, null, {
        action: "note",
        id: "old",
        partId: "legacy-1",
        text: note.text,
      }),
    ).toEqual({ value: { saved: true } });
    expect(
      await roomAgenda(project, "host", input.roomId, null, {
        action: "save",
        planVersion: 3,
        parts: [
          { ...parts[0]!, partId: "legacy-0" },
          { ...parts[2]!, partId: "legacy-2" },
        ],
      }),
    ).toEqual({ error: "part-ended" });
    expect((await read()).value).toMatchObject({ ...expected, version: 3 });
    expect(docs.get(roomPath + "/phaseNotes/old")).toEqual(note);
  });

  it("reuses a creation request only for the original owner and settings", async () => {
    const created = await createRoom(project, "host", input);
    expect(created).toEqual({
      value: { code: expect.stringMatching(/^[A-Z2-9]{6}$/) },
    });
    expect(await createRoom(project, "host", input)).toEqual(created);
    expect(await createRoom(project, "guest", input)).toEqual({
      error: "conflict",
    });
    expect(
      await createRoom(project, "host", { ...input, minutes: 45 }),
    ).toEqual({ error: "conflict" });
    expect(docs.size).toBe(3);
    expect(docs.has(roomPath + "/members/host")).toBe(false);
  });
  it("keeps one membership and a personal room link across leave and reentry", async () => {
    seed();
    const read = () => accessRoom(project, "guest", code);
    const act = (join: boolean, version: number) =>
      accessRoom(project, "guest", code, { join, version });
    expect((await read()).value).toMatchObject({
      owner: false,
      joined: false,
      version: 0,
    });
    expect((await act(false, 0)).error).toBe("not-member");
    expect((await act(true, 0)).value).toMatchObject({
      joined: true,
      version: 1,
    });
    expect((await act(true, 0)).value?.version).toBe(1);
    expect((await act(false, 1)).value).toMatchObject({
      joined: false,
      version: 2,
    });
    expect(docs.get(roomPath + "/members/guest")).toHaveProperty(
      "firstJoinedAt",
    );
    expect(docs.get("users/guest/rooms/" + input.roomId)?.code).toBe(code);
    expect((await act(true, 2)).value?.version).toBe(3);
    expect((await act(false, 1)).error).toBe("stale");
    expect(docs.get(roomPath)?.status).toBe("open");
    expect((await accessRoom(project, "host", code)).value).toMatchObject({
      owner: true,
      joined: false,
    });
    docs.get(roomPath)!.status = "ended";
    expect((await act(true, 3)).error).toBe("closed");
  });
  it("limits invalid invites per user while members can still leave", async () => {
    seed();
    await accessRoom(project, "guest", code, { join: true, version: 0 });
    for (let i = 0; i < 10; i++)
      expect((await accessRoom(project, "guest", "NOPE22")).error).toBe(
        "missing",
      );
    expect((await accessRoom(project, "guest", "NOPE22")).error).toBe(
      "limited",
    );
    expect(
      (await accessRoom(project, "guest", code, { join: false, version: 1 }))
        .value?.joined,
    ).toBe(false);
    docs.set("roomInviteAttempts/visitor", {
      startedAt: Date.now(),
      failures: 10,
    });
    expect((await accessRoom(project, "visitor", code)).error).toBe("limited");
    docs.get("roomInviteAttempts/visitor")!.startedAt = Date.now() - 61_000;
    expect((await accessRoom(project, "visitor", code)).value?.version).toBe(0);
    docs.delete(roomPath);
    expect((await accessRoom(project, "visitor", code)).error).toBe("missing");
  });
});

it("deduplicates requests and validates pending approvals at their own server time", async () => {
  seed();
  const id = input.roomId;
  docs.set(roomPath + "/members/host", { joined: true });
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const submit = (
    name: string,
    version: number,
    call: string,
    target = "part-0",
  ) =>
    transactProposal(project, id, {
      proposal: {
        id: call,
        basePlanVersion: version,
        reason: "検証",
        operations: [{ action: "rename", target, name }],
      },
    });
  const approve = (id: string, uid = "host") =>
    transactProposal(project, input.roomId, { uid, id });
  const read = (since: number | null = null) =>
    roomAgenda(project, "host", id, since);
  const ready = "準備の議論";
  expect(await submit(ready, 0, "early")).toMatchObject({
    value: { status: "not-planning" },
  });
  await roomAgenda(project, "host", id, null, { action: "start" });
  clock.mockReturnValue(180_999);
  expect(await submit(ready, 1, "prepare")).toMatchObject({
    value: { status: "applied" },
  });
  clock.mockReturnValue(181_000);
  expect(await submit(ready, 1, "prepare")).toMatchObject({
    value: { status: "applied" },
  });
  expect(await submit("別案", 1, "prepare")).toEqual({
    error: "call-conflict",
  });
  expect((await read()).value).toMatchObject({
    version: 2,
    planVersion: 2,
    appliedProposal: { changes: [expect.stringContaining(ready)] },
  });
  expect(await submit("条件", 2, "after")).toMatchObject({
    value: { status: "pending" },
  });
  expect((await read()).value).toMatchObject({
    version: 3,
    planVersion: 2,
    proposal: { id: "after" },
  });
  expect(await approve("after", "stranger")).toEqual({ error: "not-member" });
  await submit("条件の整理", 2, "newer");
  expect(await approve("after")).toMatchObject({
    value: { status: "proposal-replaced" },
  });
  clock.mockReturnValue(781_000);
  expect((await submit("終了した対象", 2, "invalid-new")).value?.status).toBe(
    "part-ended",
  );
  expect(docs.get(roomPath)!.pendingAgendaProposal).toBeNull();
  expect((await read(4)).value).toMatchObject({
    version: 5,
    planVersion: 2,
    proposalStatus: "part-ended",
  });
  expect(await approve("newer")).toMatchObject({
    value: { status: "part-ended" },
  });
  // A valid replacement and the reason the previous proposal expired are visible together.
  clock.mockReturnValue(181_000);
  await submit("前の案", 2, "expired-while-waiting");
  clock.mockReturnValue(781_000);
  await submit("候補を比較", 2, "approve", "part-1");
  expect((await read()).value).toMatchObject({
    proposalStatus: "part-ended",
    proposal: { id: "approve" },
  });
  expect(
    (
      await transactProposal(project, id, {
        uid: "host",
        id: "expired-while-waiting",
        dismiss: true,
      })
    ).value?.status,
  ).toBe("part-ended");
  await roomAgenda(project, "host", id, null, {
    action: "note",
    partId: "part-1",
    id: input.roomId,
    text: "予算",
  });
  expect(await approve("approve")).toMatchObject({
    value: { status: "applied" },
  });
  expect(await approve("approve")).toMatchObject({
    value: { status: "applied" },
  });
  expect((await read()).value).toMatchObject({
    planVersion: 3,
    parts: [{}, { name: "候補を比較", notes: ["予算"] }, {}, {}],
  });
  await submit("AI案", 3, "race", "part-1");
  const stored = docs.get(roomPath)!.agendaV3;
  await roomAgenda(project, "host", id, null, {
    action: "save",
    planVersion: 3,
    parts: stored.parts.map((p: { partId: string }) =>
      p.partId === "part-1" ? { ...p, name: "人の編集" } : p,
    ),
  });
  expect(await approve("race")).toMatchObject({
    value: { status: "agenda-stale" },
  });
  expect((await read()).value).toMatchObject({
    planVersion: 4,
    parts: [{}, { name: "人の編集" }, {}, {}],
  });
  await submit("まだ有効", 4, "expiry", "part-1");
  clock.mockReturnValue(1_700_000);
  expect(await approve("expiry")).toMatchObject({
    value: { status: "part-ended" },
  });
  const expired = (await read()).value!;
  expect(expired).toMatchObject({
    planVersion: 4,
    proposalStatus: "part-ended",
  });
  clock.mockReturnValue(1_730_000);
  const cleared = (await read("version" in expired ? expired.version : -1))
    .value!;
  expect(cleared).toMatchObject({ planVersion: 4, parts: expect.any(Array) });
  expect(cleared).not.toHaveProperty("proposalStatus");
  expect(docs.get(roomPath)!.proposalNotice).toBeNull();
  docs.get(roomPath)!.proposalNotice = { id: "old", status: "agenda-stale" };
  const legacy = await read(docs.get(roomPath)!.agendaV3.version);
  expect(legacy.value).toHaveProperty("parts");
  expect(legacy.value).not.toHaveProperty("proposalStatus");
  expect(docs.get(roomPath)!.proposalNotice).toBeNull();
  docs.get(roomPath)!.status = "closed";
  expect(await submit("終了", 4, "closed")).toEqual({ error: "closed" });
});

it("applies conversation proposals until manual confirmation, then checks the version and waits for approval", async () => {
  seed();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const id = input.roomId;
  docs.set(roomPath + "/members/host", { joined: true });
  await roomAgenda(project, "host", id, null, { action: "start" });
  const send = (call: string, version: number, name: string) =>
    transactProposal(project, id, {
      proposal: {
        id: call,
        source: "automatic",
        basePlanVersion: version,
        reason: "検証",
        operations: [{ action: "rename", target: "part-1", name }],
      },
    });
  expect((await send("before", 1, "会場選び")).value?.status).toBe("applied");
  const state = (await readMeetingContext(project, id))!;
  expect(state.parts[1]?.name).toBe("会場選び");
  expect(state.planVersion).toBe(2);
  clock.mockReturnValue(2000);
  await roomAgenda(project, "host", id, null, {
    action: "confirm",
    planVersion: state.planVersion,
    parts: state.parts,
  });
  expect((await send("old", 2, "費用の比較")).value?.status).toBe(
    "agenda-stale",
  );
  expect((await send("after", 3, "費用の比較")).value?.status).toBe("pending");
  expect((await readMeetingContext(project, id))?.parts[1]?.name).toBe(
    "会場選び",
  );
});

it("keeps a delayed worker note once alongside a human note and serves both to a former member", async () => {
  seed();
  const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
  await accessRoom(project, "host", code, { join: true, version: 0 });
  const id = input.roomId;
  const notebook = (uid: string) => readRoomNotebook(project, uid, id);
  const note = {
    action: "note",
    partId: "part-0",
    id: "ai-write",
    text: "会場費は3万円まで",
  } as const;
  expect(await notebook("host")).toEqual({ error: "meeting-in-progress" });
  expect(await appendWorkerNote(project, id, note)).toEqual({
    error: "agenda-stale",
  });
  await roomAgenda(project, "host", id, null, { action: "start" });
  clock.mockReturnValue(190_000);
  await roomAgenda(project, "host", id, null, {
    ...note,
    id: "human",
    text: "空き状況を確認する",
  });
  clock.mockReturnValue(790_000);
  for (let i = 0; i < 2; i++)
    expect(await appendWorkerNote(project, id, note)).toEqual({
      value: { saved: true },
    });
  expect(
    await appendWorkerNote(project, id, { ...note, partId: "part-1" }),
  ).toEqual({ error: "agenda-stale" });
  expect((await readMeetingContext(project, id))?.planVersion).toBe(1);
  await accessRoom(project, "host", code, { join: false, version: 1 });
  expect(
    (await accessRoom(project, "host", code)).value?.notebookAvailable,
  ).toBe(false);
  clock.mockReturnValue(2_000_000);
  expect(
    (await accessRoom(project, "host", code)).value?.notebookAvailable,
  ).toBe(true);
  expect(
    (await accessRoom(project, "uninvited", code)).value?.notebookAvailable,
  ).toBe(false);
  const expected = {
    value: {
      topic: input.topic,
      parts: [
        { partId: "part-0", notes: ["空き状況を確認する", note.text] },
        { notes: [] },
        { notes: [] },
        { notes: [] },
      ],
    },
  };
  expect(await notebook("host")).toMatchObject(expected);
  docs.get(roomPath)!.status = "closed";
  expect(await notebook("host")).toMatchObject(expected);
  expect(await notebook("uninvited")).toEqual({ error: "not-member" });
  expect(await appendWorkerNote(project, id, note)).toEqual({
    error: "closed",
  });
});

it("protects explicit proposals and accumulates dismissed automatic targets until the next plan revision", async () => {
  seed();
  const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const roomId = input.roomId;
  await accessRoom(project, "host", code, { join: true, version: 0 });
  await roomAgenda(project, "host", roomId, null, { action: "start" });
  const send = (id: string, target: string, automatic = true, version = 1) =>
    transactProposal(project, roomId, {
      proposal: {
        id,
        ...(automatic && { source: "automatic" }),
        basePlanVersion: version,
        reason: "条件",
        operations: [{ action: "rename", target, name: id }],
      },
    });
  const dismiss = (id: string) =>
    transactProposal(project, roomId, { uid: "host", id, dismiss: true });
  clock.mockReturnValue(190_000);
  expect((await send("依頼", "part-0", false)).value?.status).toBe("pending");
  expect((await send("自動", "part-1")).value?.status).toBe("suppressed");
  expect((await dismiss("依頼")).value?.status).toBe("dismissed");
  expect((await send("次案", "part-1")).value?.status).toBe("pending");
  expect((await dismiss("次案")).value?.status).toBe("dismissed");
  expect((await dismiss("依頼")).value?.status).toBe("dismissed");
  for (const target of ["part-0", "part-1"])
    expect((await send(target, target)).value?.status).toBe("suppressed");
  expect((await send("新しい依頼", "part-0", false)).value?.status).toBe(
    "pending",
  );
  expect(
    (await transactProposal(project, roomId, { uid: "host", id: "新しい依頼" }))
      .value?.status,
  ).toBe("applied");
  expect((await send("版更新後", "part-1", true, 2)).value?.status).toBe(
    "pending",
  );
});

it("publishes room-scoped research exactly once, expires an abandoned lookup and preserves the plan", async () => {
  seed();
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const room = input.roomId;
  const read = (uid: string, since: number | null = null) =>
    roomAgenda(project, uid, room, since);
  const send = (cmd: Parameters<typeof transactResearch>[2]) =>
    transactResearch(project, room, cmd);
  for (const uid of ["a", "b"])
    await accessRoom(project, uid, code, { join: true, version: 0 });
  const start = {
    action: "start",
    id: "r1",
    question: "休日料金は？",
  } as const;
  expect(await send(start)).toEqual({ status: "pending" });
  expect(await send(start)).toEqual({ status: "pending" });
  expect(await send({ ...start, question: "人口は？" })).toEqual({
    status: "conflict",
  });
  expect(await send({ ...start, id: "r2" })).toEqual({ status: "busy" });
  const first = (await read("a")).value!;
  expect(first).toMatchObject({
    research: [{ status: "pending", deadline: 31000 }],
  });
  expect((await read("other")).error).toBe("not-member");
  expect((await read("b")).value).toEqual(first);
  now.mockReturnValue(31000);
  const expires = (await read("b", "version" in first ? first.version : -1))
    .value!;
  expect(expires).toMatchObject({ research: [{ status: "timeout" }] });
  const finish = {
    action: "finish",
    id: "r1",
    status: "verified",
    finding: {
      answer: "休日の基本料金は1万円です。",
      conditions: "合成例 · 全日",
      title: "料金表",
      publisher: "施設",
      url: "https://www.f-cp.jp/shimin/guide/guide05/#c01",
    },
  } as const;
  expect(await send(finish)).toEqual({ status: "timeout" });
  await send({ ...start, id: "r2" });
  const accepted = { ...finish, id: "r2" };
  expect(await send(accepted)).toEqual({ status: "verified" });
  const version = docs.get(roomPath)!.agendaV3.version;
  expect(await send(accepted)).toEqual({ status: "verified" });
  expect(
    await send({
      ...accepted,
      finding: { ...accepted.finding, answer: "別の数値" },
    }),
  ).toEqual({ status: "conflict" });
  expect(docs.get(roomPath)!.agendaV3.version).toBe(version);
  const grant = { action: "present", id: "r2", grant: "g1" } as const;
  for (let i = 0; i < 2; i++)
    expect(await send(grant)).toEqual({
      status: "present",
      speech: finish.finding.answer,
    });
  expect(await send({ ...grant, grant: "g2" })).toEqual({
    status: "unavailable",
  });
  expect((await read("a")).value).toMatchObject({
    planVersion: 0,
    research: [
      { status: "timeout" },
      { presented: true, finding: finish.finding },
    ],
  });
  await accessRoom(project, "b", code, { join: false, version: 1 });
  expect((await read("b")).error).toBe("not-member");
  await send({ ...start, id: "r3" });
  docs.get(roomPath)!.agendaV3.confirmedAt = 1000;
  now.mockReturnValue(1000 + input.minutes * 60_000);
  expect(await send({ ...finish, id: "r3" })).toEqual({ status: "ended" });
  expect(await send({ ...start, id: "r4" })).toEqual({ status: "ended" });
  const notebook = await readRoomNotebook(project, "b", room);
  expect(notebook.value?.research).toHaveLength(1);
  expect(notebook.value?.research[0]).toMatchObject({
    finding: finish.finding,
  });
  expect(await readRoomNotebook(project, "other", room)).toEqual({
    error: "not-member",
  });
});
