import "server-only";
import { randomInt } from "node:crypto";
import { notebookAvailable } from "./meeting-agenda";
import { roomDatabase } from "./room-database";
import {
  FieldValue,
  type Transaction,
  type DocumentReference,
} from "firebase-admin/firestore";
import {
  membershipTransition,
  type MembershipChange,
  type NewRoom,
} from "@/server/domain/room-membership";

async function readPair(
  tx: Transaction,
  first: DocumentReference,
  second: DocumentReference,
) {
  const docs = await tx.getAll(first, second);
  return [docs[0]!, docs[1]!] as const;
}

function inviteCode() {
  // Exclude easily confused characters, including I in the reserved demo code AINOTE.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 6 },
    () => alphabet[randomInt(alphabet.length)],
  ).join("");
}

export async function listRooms(projectId: string, uid: string) {
  const result = await roomDatabase(projectId)
    .collection("users")
    .doc(uid)
    .collection("rooms")
    .orderBy("updatedAt", "desc")
    .limit(30)
    .get();
  return result.docs.map((doc) => ({
    code: doc.get("code") as string,
    topic: doc.get("topic") as string,
  }));
}

export async function createRoom(
  projectId: string,
  uid: string,
  input: NewRoom,
) {
  const db = roomDatabase(projectId);
  const { roomId, topic, minutes, member } = input;
  const room = db.collection("rooms").doc(roomId);
  const index = db.collection("users").doc(uid).collection("rooms").doc(roomId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = inviteCode();
    const invite = db.collection("roomInvites").doc(code);
    const result = await db.runTransaction(async (tx) => {
      const [existing, collision] = await readPair(tx, room, invite);
      if (existing.exists) {
        if (
          existing.get("ownerUid") !== uid ||
          existing.get("topic") !== topic ||
          existing.get("minutes") !== minutes ||
          existing.get("member") !== member
        )
          return { error: "conflict" } as const;
        return { value: { code: existing.get("code") as string } };
      }
      if (collision.exists) return null;
      const now = FieldValue.serverTimestamp();
      tx.create(room, {
        ownerUid: uid,
        topic,
        minutes,
        member,
        code,
        status: "open",
        createdAt: now,
      });
      tx.create(invite, { roomId });
      tx.create(index, { topic, code, updatedAt: now });
      return { value: { code } };
    });
    if (result) return result;
  }
  return { error: "unavailable" } as const;
}

export async function accessRoom(
  projectId: string,
  uid: string,
  code: string,
  change?: MembershipChange,
  disconnectedVersion?: number,
) {
  const db = roomDatabase(projectId);
  const invites = db.collection("roomInvites");
  const attempts = db.collection("roomInviteAttempts").doc(uid);
  return db.runTransaction(async (tx) => {
    const [invite, recent] = await readPair(tx, invites.doc(code), attempts);
    const now = Date.now();
    const start = Number(recent.get("startedAt") ?? 0);
    const withinWindow = now - start < 60_000;
    const failures = withinWindow ? Number(recent.get("failures") ?? 0) : 0;
    if (!invite.exists) {
      if (failures >= 10) return { error: "limited" } as const;
      tx.set(attempts, {
        startedAt: withinWindow ? start : now,
        failures: failures + 1,
      });
      return { error: "missing" } as const;
    }
    const room = db.collection("rooms").doc(invite.get("roomId"));
    const member = room.collection("members").doc(uid);
    const [settings, record] = await readPair(tx, room, member);
    if (!settings.exists) return { error: "missing" } as const;
    const owner = settings.get("ownerUid") === uid;
    if (!owner && !record.exists && failures >= 10)
      return { error: "limited" } as const;
    const current = {
      joined: record.get("joined") === true,
      version: Number(record.get("version") ?? 0),
    };
    const topic = settings.get("topic") as string;
    const open = settings.get("status") === "open";
    const details = {
      roomId: room.id,
      code,
      topic,
      minutes: settings.get("minutes") as number,
      member: settings.get("member") as string,
      owner,
      open,
      notebookAvailable: record.exists && notebookAvailable(settings, now),
      leaving: current.joined && record.get("voiceLeaving") === true,
    };
    if (!change) return { value: { ...details, ...current } };
    const transition = membershipTransition(current, change, open);
    if (transition === "unchanged")
      return { value: { ...details, ...current } };
    if (transition !== "apply") return { error: transition };
    // Stop issuing tickets before eviction. A failed LiveKit call leaves this
    // visit retryable; a delayed eviction can never target the next visit.
    if (
      !change.join &&
      record.get("voiceVersion") === current.version &&
      disconnectedVersion !== current.version
    ) {
      if (!record.get("voiceLeaving"))
        tx.update(member, { voiceLeaving: true });
      return {
        value: { ...details, ...current, leaving: true },
        disconnectVersion: current.version,
      };
    }

    const state = { joined: change.join, version: current.version + 1 };
    const time = FieldValue.serverTimestamp();
    if (change.join) {
      if (record.exists) tx.update(member, { ...state, lastJoinedAt: time });
      else
        tx.create(member, {
          ...state,
          firstJoinedAt: time,
          lastJoinedAt: time,
          lastLeftAt: null,
        });
      tx.set(db.collection("users").doc(uid).collection("rooms").doc(room.id), {
        topic,
        code,
        updatedAt: time,
      });
    } else {
      tx.update(member, { ...state, lastLeftAt: time, voiceLeaving: false });
    }
    return { value: { ...details, ...state, leaving: false } };
  });
}

export async function admitRoomVoice(
  projectId: string,
  uid: string,
  roomId: string,
) {
  const db = roomDatabase(projectId);
  const room = db.collection("rooms").doc(roomId);
  const member = room.collection("members").doc(uid);
  return db.runTransaction(async (tx) => {
    const [settings, membership] = await readPair(tx, room, member);
    if (
      !settings.exists ||
      membership.get("joined") !== true ||
      membership.get("voiceLeaving") === true
    )
      return { error: "not-member" } as const;
    if (settings.get("status") !== "open") return { error: "closed" } as const;
    const version = membership.get("version") as number;
    if (membership.get("voiceVersion") !== version)
      tx.update(member, { voiceVersion: version });
    return { value: { version, member: settings.get("member") as string } };
  });
}
