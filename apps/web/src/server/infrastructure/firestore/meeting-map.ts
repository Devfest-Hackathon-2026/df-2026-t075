import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { roomDatabase } from "./room-database";

function mapOrigin(settings: DocumentSnapshot, roomId: string): string | null {
  const origin: unknown = settings.get("origin");
  const allowedRoom: unknown = settings.get("roomId");
  if (
    settings.get("enabled") !== true ||
    (allowedRoom !== undefined && allowedRoom !== roomId) ||
    typeof settings.get("session") !== "string" ||
    typeof origin !== "string"
  )
    return null;
  const cloud = /^https:\/\/[a-z0-9-]+\.(?:[a-z0-9-]+\.)?run\.app$/.test(
    origin,
  );
  const local =
    process.env.FIRESTORE_EMULATOR_HOST &&
    /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin);
  return cloud || local ? origin : null;
}

export async function roomMapAvailable(project: string, roomId: string) {
  const settings = await roomDatabase(project)
    .doc("roomMapSettings/default")
    .get();
  return Boolean(mapOrigin(settings, roomId));
}

// The browser receives a single-use room ticket. Its Google ID token stays on the Web origin.
export async function issueMapTicket(
  project: string,
  roomId: string,
  user: { uid: string; displayName: string | null },
) {
  const db = roomDatabase(project);
  const room = db.collection("rooms").doc(roomId);
  const member = room.collection("members").doc(user.uid);
  const ticket = randomBytes(32).toString("base64url");
  return db.runTransaction(async (tx) => {
    const [settings, visit] = await tx.getAll(room, member);
    if (
      !settings!.exists ||
      visit!.get("joined") !== true ||
      visit!.get("voiceLeaving") === true
    )
      return { error: "not-member" } as const;
    if (settings!.get("status") !== "open") return { error: "closed" } as const;
    const relay = await tx.get(db.doc("roomMapSettings/default"));
    const origin = mapOrigin(relay, roomId);
    const stamp = Date.now();
    if (!origin) return { error: "map-offline" } as const;
    const detail = {
      hash: createHash("sha256").update(ticket).digest("hex"),
      session: relay.get("session"),
      expiresAt: stamp + 30_000,
      version: visit!.get("version"),
      name: user.displayName?.trim().slice(0, 70) || "参加者",
    };
    tx.update(member, { mapTicket: detail });
    return {
      value: {
        url: origin.replace(/^http/, "ws") + "/live-map/socket",
        roomId,
        uid: user.uid,
        ticket,
      },
    };
  });
}
