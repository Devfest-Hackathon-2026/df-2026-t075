import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const leaseMs = 60_000;

export function memberAccess(db, origin) {
  const config = db.doc("roomMapSettings/default");
  const instance = randomUUID();

  function enabledFor(settings, roomId) {
    const allowedRoom = settings.get("roomId");
    return (
      settings.get("enabled") === true &&
      settings.get("origin") === origin &&
      typeof settings.get("session") === "string" &&
      (allowedRoom === undefined || allowedRoom === roomId)
    );
  }

  async function consume(message) {
    const { roomId, uid, ticket } = message;
    if (
      typeof roomId !== "string" ||
      !uuid.test(roomId) ||
      typeof uid !== "string" ||
      !uid ||
      uid.length > 128 ||
      uid.includes("/") ||
      typeof ticket !== "string" ||
      !/^[\w-]{43}$/.test(ticket)
    )
      return null;
    const room = db.collection("rooms").doc(roomId);
    const member = room.collection("members").doc(uid);
    const hash = createHash("sha256").update(ticket).digest("hex");
    return db.runTransaction(async (tx) => {
      const [settings, visit] = await tx.getAll(room, member);
      const ownerUid = settings.get("ownerUid");
      const proof = visit.get("mapTicket");
      if (
        settings.get("status") !== "open" ||
        typeof ownerUid !== "string" ||
        visit.get("joined") !== true ||
        visit.get("voiceLeaving") === true ||
        !proof ||
        proof.version !== visit.get("version") ||
        !(proof.expiresAt > Date.now()) ||
        proof.hash !== hash
      )
        return null;
      const enabled = await tx.get(config);
      if (
        !enabledFor(enabled, roomId) ||
        proof.session !== enabled.get("session")
      )
        return null;
      tx.update(member, { mapTicket: FieldValue.delete() });
      return {
        uid,
        ownerUid,
        roomId,
        name: proof.name,
        version: proof.version,
        host: ownerUid === uid,
        session: proof.session,
      };
    });
  }

  function watch(person, revoke) {
    const ownerUid = person.ownerUid;
    const room = db.collection("rooms").doc(person.roomId);
    const off = [
      room.onSnapshot((s) => {
        if (s.get("status") !== "open" || s.get("ownerUid") !== ownerUid)
          revoke();
      }, revoke),
      room
        .collection("members")
        .doc(person.uid)
        .onSnapshot((s) => {
          if (
            s.get("version") !== person.version ||
            s.get("joined") !== true ||
            s.get("voiceLeaving") === true
          )
            revoke();
        }, revoke),
      config.onSnapshot((s) => {
        if (
          !enabledFor(s, person.roomId) ||
          s.get("session") !== person.session
        )
          revoke();
      }, revoke),
    ];
    return () => off.forEach((stop) => stop());
  }

  async function roomLease(person) {
    // A pilot room may still be running on the previous revision. Keep using
    // its existing lease so two revisions cannot open a second copy of its map.
    const pilot = db.collection("roomMapHosts").doc(person.ownerUid);
    const legacy = await pilot.get();
    if (legacy.exists) {
      const slot = pilot.collection("sessions").doc("active");
      const previousRoom =
        legacy.get("roomId") ?? (await slot.get()).get("roomId");
      if (previousRoom === person.roomId) return slot;
    }
    return db
      .collection("rooms")
      .doc(person.roomId)
      .collection("mapSessions")
      .doc("active");
  }

  // Only the lease holder accepts audio, including during a revision change.
  async function claim(slot, roomId, generation, renewing = false) {
    return db.runTransaction(async (tx) => {
      const s = await tx.get(slot);
      const now = Date.now();
      const ours =
        s.get("instance") === instance && s.get("generation") === generation;
      if (
        renewing
          ? !ours || s.get("until") <= now
          : s.exists && s.get("until") > now && !ours
      )
        return 0;
      const until = now + leaseMs;
      tx.set(slot, { instance, generation, roomId, until });
      return until;
    });
  }
  async function release(slot, generation) {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(slot);
      if (s.get("instance") === instance && s.get("generation") === generation)
        tx.update(slot, { until: 0 });
    });
  }
  return { consume, watch, roomLease, claim, release };
}
