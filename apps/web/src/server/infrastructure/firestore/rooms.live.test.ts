import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { expect, it, vi } from "vitest";
import { accessRoom, admitRoomVoice, createRoom, listRooms } from "./rooms";
import {
  appendWorkerNote,
  readRoomNotebook,
  roomAgenda,
  readMeetingContext,
  transactProposal,
  transactResearch,
} from "./meeting-agenda";

vi.mock("server-only", () => ({}));

it.runIf(process.env.ROOMS_LIVE_TEST === "1")(
  "persists two participants and cleans up their temporary room in real Firestore",
  async () => {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (
      !project ||
      process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST
    ) {
      throw new Error(
        "Set the target Firestore project and disable the emulators.",
      );
    }
    const db = getFirestore(initializeApp({ projectId: project }, "user-auth"));
    const id = randomUUID();
    const host = "room-check-host-" + id;
    const guest = "room-check-guest-" + id;
    const room = db.collection("rooms").doc(id);
    const member = (uid: string) => room.collection("members").doc(uid);
    const oldNote = room.collection("phaseNotes").doc(randomUUID());
    const newNote = room.collection("phaseNotes").doc(randomUUID());
    const concurrentNote = room.collection("phaseNotes").doc(randomUUID());
    const call = room.collection("agendaCalls").doc(randomUUID());
    const withdrawnCall = room.collection("agendaCalls").doc(randomUUID());
    const lateNote = room.collection("phaseNotes").doc(randomUUID());
    const humanNote = room.collection("phaseNotes").doc(randomUUID());
    const proposalNote = room.collection("phaseNotes").doc(randomUUID());
    const index = (uid: string) =>
      db.collection("users").doc(uid).collection("rooms").doc(id);
    try {
      const created = await createRoom(project, host, {
        roomId: id,
        topic: "入退室の動作確認",
        minutes: 15,
        member: "ノト",
      });
      if (!("value" in created) || !created.value)
        throw new Error("Room creation failed.");
      const { code } = created.value;
      expect((await member(host).get()).exists).toBe(false);
      expect(await admitRoomVoice(project, host, id)).toEqual({
        error: "not-member",
      });
      for (const uid of [host, guest]) {
        const result = await accessRoom(project, uid, code, {
          join: true,
          version: 0,
        });
        expect(result.value).toMatchObject({ joined: true, version: 1 });
      }
      const first = (await member(host).get()).get("firstJoinedAt");
      expect(first).toBeInstanceOf(Timestamp);
      expect((await admitRoomVoice(project, host, id)).value?.version).toBe(1);
      const parts = [
        { name: "条件", minutes: 3 },
        { name: "候補決め", minutes: 10 },
        { name: "振り返り", minutes: 2 },
      ];
      await room.update({
        agenda: {
          version: 2,
          planningAt: Date.now() - 5 * 60_000,
          confirmedAt: Date.now() - 4 * 60_000,
          parts,
        },
      });
      await oldNote.create({
        part: 1,
        text: "二つを比較",
        createdAt: Timestamp.fromMillis(3),
      });
      expect(await readMeetingContext(project, id)).toMatchObject({
        topic: "入退室の動作確認",
        currentPartId: "legacy-1",
        version: 2,
        notes: [{ partId: "legacy-1", text: "二つを比較" }],
      });
      expect((await room.get()).get("agendaV3")).toBeUndefined();
      const append = {
        action: "note",
        partId: "legacy-1",
        id: newNote.id,
        text: "比較の条件",
      } as const;
      const read = () => roomAgenda(project, host, id, null);
      const [firstRead, write] = await Promise.all([
        read(),
        roomAgenda(project, guest, id, null, append),
      ]);
      expect(firstRead.value).toMatchObject({
        parts: [
          { partId: "legacy-0" },
          { partId: "legacy-1" },
          { partId: "legacy-2" },
        ],
      });
      expect(write.value).toEqual({ saved: true });
      expect(
        (await roomAgenda(project, guest, id, null, append)).value,
      ).toEqual({ saved: true });
      expect(
        (
          await roomAgenda(project, host, id, null, {
            action: "save",
            planVersion: 2,
            parts: [
              { ...parts[0]!, partId: "legacy-0" },
              { ...parts[2]!, partId: "legacy-2" },
            ],
          })
        ).error,
      ).toBe("current-part-moved");
      expect((await read()).value).toMatchObject({
        version: 3,
        parts: [
          { notes: [] },
          { name: "候補決め", notes: ["二つを比較", append.text] },
          { notes: [] },
        ],
      });
      const prior = (await room.get()).get("agendaV3");
      expect(prior).toMatchObject({ version: 3, planVersion: 2 });
      const plan = {
        action: "save",
        planVersion: 2,
        parts: [
          { ...parts[0]!, partId: "legacy-0" },
          { name: "候補決め", minutes: 5, partId: "legacy-1" },
          { name: "追加の比較", minutes: 5, partId: null },
          { ...parts[2]!, partId: "legacy-2" },
        ],
      } as const;
      const competingEdit = (uid: string, name: string) =>
        roomAgenda(project, uid, id, null, {
          ...plan,
          parts: plan.parts.map((p) =>
            p.partId === null ? { ...p, name } : p,
          ),
        });
      const [a, b, memo] = await Promise.all([
        competingEdit(host, "比較A"),
        competingEdit(guest, "比較B"),
        roomAgenda(project, guest, id, null, {
          ...append,
          id: concurrentNote.id,
          text: "評価軸を共有",
        }),
      ]);
      expect(memo.value).toEqual({ saved: true });
      expect([a, b].filter((result) => "value" in result)).toHaveLength(1);
      expect(
        [a, b].filter((result) => result.error === "agenda-stale"),
      ).toHaveLength(1);
      expect((await read()).value).toMatchObject({
        version: 5,
        planVersion: 3,
        parts: [
          {},
          { minutes: 5, notes: ["二つを比較", append.text, "評価軸を共有"] },
          { minutes: 5 },
          { minutes: 2 },
        ],
      });
      const proposal = {
        id: call.id,
        basePlanVersion: 3,
        reason: "会場費を確認",
        operations: [
          {
            action: "rename" as const,
            target: "legacy-1",
            name: "3万円以内で比較",
          },
        ],
      };
      const submit = () => transactProposal(project, id, { proposal });
      const duplicate = await Promise.all([submit(), submit()]);
      expect(duplicate.map((r) => r.value?.status)).toEqual([
        "pending",
        "pending",
      ]);
      expect(
        await transactProposal(project, id, {
          proposal: { ...proposal, reason: "別案" },
        }),
      ).toEqual({ error: "call-conflict" });
      expect((await room.collection("agendaCalls").get()).size).toBe(1);
      expect((await read()).value).toMatchObject({
        version: 6,
        planVersion: 3,
        proposal: { id: call.id },
      });
      await roomAgenda(project, guest, id, null, {
        ...append,
        id: proposalNote.id,
        text: "承認前のメモ",
      });
      const approvals = await Promise.all(
        [host, guest].map((uid) =>
          transactProposal(project, id, { uid, id: call.id }),
        ),
      );
      expect(approvals.map((r) => r.value?.status)).toEqual([
        "applied",
        "applied",
      ]);
      expect((await read()).value).toMatchObject({
        version: 8,
        planVersion: 4,
        parts: [
          {},
          {
            name: "3万円以内で比較",
            notes: ["二つを比較", append.text, "評価軸を共有", "承認前のメモ"],
          },
          {},
          {},
        ],
      });
      await transactProposal(project, id, {
        proposal: {
          ...proposal,
          id: withdrawnCall.id,
          basePlanVersion: 4,
          operations: [{ action: "rename", target: "legacy-1", name: "AI案" }],
        },
      });
      const { parts: committed } = (await readMeetingContext(project, id))!;
      const rename = (name: string, planVersion: number) =>
        roomAgenda(project, guest, id, null, {
          action: "save",
          planVersion,
          parts: committed.map((p) => ({
            partId: p.partId,
            minutes: p.minutes,
            name: p.partId === "legacy-1" ? name : p.name,
          })),
        });
      expect((await rename("人の比較案", 4)).value).toMatchObject({
        saved: true,
      });
      expect((await read()).value).toMatchObject({
        proposalStatus: "agenda-stale",
        planVersion: 5,
      });
      expect((await rename("次の比較案", 5)).value).toMatchObject({
        saved: true,
      });
      const updated = (await read()).value;
      expect(updated).toMatchObject({ planVersion: 6 });
      expect(updated).not.toHaveProperty("proposalStatus");
      const leave = { join: false, version: 1 };
      const pending = await accessRoom(project, host, code, leave);
      expect(pending.disconnectVersion).toBe(1);
      expect(await admitRoomVoice(project, host, id)).toEqual({
        error: "not-member",
      });
      expect(
        (
          await accessRoom(
            project,
            host,
            code,
            leave,
            pending.disconnectVersion,
          )
        ).value?.joined,
      ).toBe(false);
      const left = (await member(host).get()).get("lastLeftAt");
      expect(left).toBeInstanceOf(Timestamp);
      expect((await member(guest).get()).get("joined")).toBe(true);
      expect((await room.get()).get("status")).toBe("open");
      expect(
        (await accessRoom(project, host, code, { join: true, version: 2 }))
          .value?.version,
      ).toBe(3);
      const rejoined = await member(host).get();
      expect(rejoined.get("firstJoinedAt")).toEqual(first);
      expect(rejoined.get("lastLeftAt")).toEqual(left);
      expect(rejoined.get("lastJoinedAt").toMillis()).toBeGreaterThan(
        first.toMillis(),
      );
      expect((await room.collection("members").get()).size).toBe(2);
      expect(
        (await listRooms(project, guest)).map((entry) => entry.code),
      ).toEqual([code]);
      const delayed = {
        ...append,
        id: lateNote.id,
        partId: "legacy-0",
        text: "会場費は3万円まで",
      };
      const human = { ...delayed, id: humanNote.id, text: "出欠を確認" };
      const writes = await Promise.all([
        appendWorkerNote(project, id, delayed),
        appendWorkerNote(project, id, delayed),
        roomAgenda(project, guest, id, null, human),
      ]);
      for (const result of writes)
        expect(result).toEqual({ value: { saved: true } });
      const researchId = randomUUID();
      const request = {
        action: "start",
        id: researchId,
        question: "合成例の休日料金は？",
      } as const;
      const result = {
        action: "finish",
        id: researchId,
        status: "verified",
        finding: {
          answer: "合成例では173,990円",
          conditions: "全日、市内",
          publisher: "施設",
          title: "料金表",
          url: "https://www.f-cp.jp/shimin/guide/guide05/#c01",
        },
      } as const;
      expect(await transactResearch(project, id, request)).toEqual({
        status: "pending",
      });
      await Promise.all([
        transactResearch(project, id, result),
        transactResearch(project, id, result),
      ]);
      const grants = await Promise.all(
        [host, guest].map(() =>
          transactResearch(project, id, {
            action: "present",
            id: researchId,
            grant: randomUUID(),
          }),
        ),
      );
      expect(grants.map((g) => g.status).sort()).toEqual([
        "present",
        "unavailable",
      ]);
      await accessRoom(project, guest, code, { join: false, version: 1 });
      await room.update({ status: "closed" });
      const notebook = await readRoomNotebook(project, guest, id);
      expect(notebook.value?.research).toMatchObject([
        { id: researchId, finding: result.finding },
      ]);
      expect(notebook.value?.parts[0]?.notes.sort()).toEqual(
        [delayed.text, human.text].sort(),
      );
      expect(
        await readRoomNotebook(project, "room-check-outsider-" + id, id),
      ).toEqual({ error: "not-member" });
      expect(await appendWorkerNote(project, id, delayed)).toEqual({
        error: "closed",
      });
    } finally {
      const saved = await room.get();
      if (saved.exists && saved.get("ownerUid") === host) {
        const refs = [
          oldNote,
          newNote,
          concurrentNote,
          proposalNote,
          lateNote,
          humanNote,
          call,
          withdrawnCall,
          member(host),
          member(guest),
          index(host),
          index(guest),
          db.collection("roomInvites").doc(saved.get("code")),
          room,
        ];
        const batch = db.batch();
        for (const ref of refs) batch.delete(ref);
        await batch.commit();
        expect((await db.getAll(...refs)).every((doc) => !doc.exists)).toBe(
          true,
        );
      }
    }
  },
  90_000,
);
