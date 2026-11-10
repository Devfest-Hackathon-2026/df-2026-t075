import "server-only";
import {
  proposalNotice,
  type ProposalNotice,
} from "@/server/application/proposal-notice";
import { createHash } from "node:crypto";
import {
  evaluateProposal,
  type Proposal,
} from "@/server/domain/agenda-proposal";
import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {
  accessAgenda,
  appendPhaseNote,
  withPhaseNotes,
  type NoteCommand,
  agendaAccessError,
  type PhaseNote,
} from "@/server/application/meeting-agenda";
import {
  initialAgenda,
  isPreparing,
  schedule,
  type Agenda,
  type AgendaCommand,
  type PartPlan,
} from "@/server/domain/meeting-agenda";
import {
  expireResearch,
  publicResearch,
  updateResearch,
  type Research,
  type ResearchCommand,
} from "@/server/domain/meeting-research";
import { roomDatabase } from "./room-database";

// The old server overwrites agenda.parts on save. Its checks reject all new
// writes once confirmed when the only row is the final (non-noteable) part.
export const reloadAgendaMessage =
  "進行メモを更新しました。ページを再読み込みしてください。";
const retiredAgenda: Agenda = {
  version: -1,
  planVersion: -1,
  planningAt: 0,
  confirmedAt: 0,
  nextPartNumber: 0,
  parts: [{ partId: "reload-notice", name: reloadAgendaMessage, minutes: 2 }],
};

type PreviousAgenda = Omit<
  Agenda,
  "parts" | "nextPartNumber" | "planVersion"
> & {
  parts: (Omit<PartPlan, "partId"> & { partId?: string })[];
  nextPartNumber?: number;
};

function importAgenda(previous: PreviousAgenda): Agenda {
  let next = previous.nextPartNumber ?? 0;
  const parts = previous.parts.map((part, index) => ({
    ...part,
    // A previous fixed-ID writer may have allocated and retired IDs before
    // an old save stripped them. Never reuse those numbers for missing IDs.
    partId:
      part.partId ??
      (previous.nextPartNumber === undefined
        ? `legacy-${index}`
        : `part-${next++}`),
  }));
  return {
    ...previous,
    planVersion: previous.version,
    parts,
    nextPartNumber: next,
  };
}

function readNote(data: DocumentData, numberedParts: string[]): PhaseNote {
  const partId = data.partId ?? numberedParts[data.part];
  if (typeof partId !== "string") throw new Error("Unknown stored note target");
  return { partId, text: data.text };
}

async function readAgendaRoom(
  reader: Pick<Firestore, "getAll">,
  room: DocumentReference,
  uid: string,
) {
  const [settings, membership] = await reader.getAll(
    room,
    room.collection("members").doc(uid),
  );
  return {
    settings: settings!,
    minutes: settings!.get("minutes") as number,
    open: settings!.get("status") === "open",
    joined: settings!.exists && membership!.get("joined") === true,
  };
}

// Serve old tabs from the read-only view without reading notes or migrating a room.
export async function legacyRoomAgenda(
  projectId: string,
  uid: string,
  roomId: string,
  method: "GET" | "POST",
) {
  const db = roomDatabase(projectId);
  const room = await readAgendaRoom(
    db,
    db.collection("rooms").doc(roomId),
    uid,
  );
  const denied = agendaAccessError(room);
  if (denied) return { error: denied } as const;
  if (method === "POST") return { error: "reload-required" } as const;
  const timeline = schedule(retiredAgenda, room.minutes);
  return {
    value: {
      ...timeline,
      serverNow: Date.now(),
      version: retiredAgenda.version,
      parts: timeline.parts.map((part) => ({ ...part, notes: [] as string[] })),
    },
  };
}

function storedAgenda(
  settings: FirebaseFirestore.DocumentSnapshot,
  minutes: number,
) {
  const stored = settings.get("agendaV3") as
    (Agenda & { numberedParts: string[] }) | undefined;
  const fixed = settings.get("agendaV2") as
    (Omit<Agenda, "planVersion"> & { numberedParts: string[] }) | undefined;
  const previous = settings.get("agenda") as PreviousAgenda | undefined;
  if (stored)
    return {
      agenda: stored,
      numberedParts: stored.numberedParts,
      migrateOnRead: false,
      stored: true,
    };
  if (fixed)
    return {
      agenda: { ...fixed, planVersion: fixed.version },
      numberedParts: fixed.numberedParts,
      migrateOnRead: false,
      stored: false,
    };
  const agenda = previous ? importAgenda(previous) : initialAgenda(minutes);
  // Freeze the order the original numbered-note writer actually saw.
  return {
    agenda,
    numberedParts: previous ? agenda.parts.map((p) => p.partId) : [],
    migrateOnRead: !!previous,
    stored: false,
  };
}

function agendaFields(
  updated: Agenda,
  origin: ReturnType<typeof storedAgenda>,
) {
  const { stored, numberedParts } = origin;
  return {
    agendaV3: { ...updated, numberedParts },
    ...(!stored && {
      agendaV2: { ...retiredAgenda, numberedParts },
      agenda: retiredAgenda,
    }),
  };
}

type Pending = { proposal: Proposal; changes: string[] };
type ProposalAction =
  { proposal: Proposal } | { uid: string; id: string; dismiss?: boolean };

export async function transactProposal(
  projectId: string,
  roomId: string,
  action: ProposalAction,
) {
  const db = roomDatabase(projectId);
  const room = db.collection("rooms").doc(roomId);
  const decision = "uid" in action;
  const id = decision ? action.id : action.proposal.id;
  const receipt = room.collection("agendaCalls").doc(id);
  return db.runTransaction(async (tx) => {
    const [settings, call, member] = await tx.getAll(
      room,
      receipt,
      ...(decision ? [room.collection("members").doc(action.uid)] : []),
    );
    if (decision && member?.get("joined") !== true)
      return { error: "not-member" } as const;
    if (settings!.get("status") !== "open") return { error: "closed" } as const;
    const minutes = settings!.get("minutes") as number;
    const origin = storedAgenda(settings!, minutes);
    const { agenda } = origin;
    let pending = settings!.get("pendingAgendaProposal") as
      Pending | null | undefined;
    const now = Date.now();
    const digest = decision
      ? null
      : createHash("sha256")
          .update(JSON.stringify(action.proposal))
          .digest("hex");
    if (!decision && call!.exists) {
      return digest === call!.get("digest")
        ? { value: { status: call!.get("status") as string } }
        : ({ error: "call-conflict" } as const);
    }
    if (decision && action.dismiss && call!.get("dismissed") === true)
      return { value: { status: "dismissed" } };
    if (decision && !action.dismiss && call!.get("approved") === true)
      return { value: { status: "applied" } };
    if (decision && pending?.proposal.id !== id) {
      const notice = settings!.get("proposalNotice");
      return {
        value: {
          status:
            notice?.id === id ? String(notice.status) : "proposal-replaced",
        },
      };
    }
    const displayRevision = { ...agenda, version: agenda.version + 1 };
    const cleared = {
      ...agendaFields(displayRevision, origin),
      pendingAgendaProposal: null,
    };
    let notice: ProposalNotice | null = null;
    let update: DocumentData | undefined;
    if (!decision && pending) {
      const checked = evaluateProposal(agenda, pending.proposal, minutes, now);
      if (typeof checked === "string") {
        notice = proposalNotice(
          pending.proposal.id,
          checked,
          agenda.planVersion,
          now,
        );
        update = { ...cleared, proposalNotice: notice };
        pending = null;
      }
    }
    const proposal = decision ? pending!.proposal : action.proposal;
    const result = evaluateProposal(agenda, proposal, minutes, now);
    const dismissed = settings!.get("dismissedAgendaTargets") as
      { planVersion: number; targets: string[] } | undefined;
    const targets =
      dismissed?.planVersion === agenda.planVersion ? dismissed.targets : [];
    let status: string;
    if (typeof result === "string") {
      status = result;
      if (decision)
        update = {
          ...cleared,
          proposalNotice: proposalNotice(id, status, agenda.planVersion, now),
        };
    } else if (decision && action.dismiss) {
      status = "dismissed";
      update = {
        ...cleared,
        proposalNotice: null,
        dismissedAgendaTargets: {
          planVersion: agenda.planVersion,
          targets: [
            ...new Set([
              ...targets,
              ...proposal.operations.map((op) => op.target),
            ]),
          ],
        },
      };
      tx.update(receipt, { dismissed: true });
    } else if (
      !decision &&
      proposal.source === "automatic" &&
      (proposal.operations.some((op) => targets.includes(op.target)) ||
        (pending && pending.proposal.source !== "automatic"))
    ) {
      status = "suppressed";
    } else {
      const apply = decision || isPreparing(agenda, now);
      status = apply ? "applied" : "pending";
      update = {
        ...agendaFields(apply ? result.updated : displayRevision, origin),
        pendingAgendaProposal: apply
          ? null
          : { proposal, changes: result.changes },
        lastAppliedProposal: apply
          ? {
              planVersion: result.updated.planVersion,
              reason: proposal.reason,
              changes: result.changes,
            }
          : null,
        proposalNotice: notice && {
          ...notice,
          planVersion: apply ? result.updated.planVersion : agenda.planVersion,
        },
      };
    }
    if (update) tx.update(room, update);
    if (!decision) tx.create(receipt, { digest, status });
    else if (status === "applied") tx.update(receipt, { approved: true });
    return { value: { status } };
  });
}

// Read the same timeline and legacy note mapping, without performing a migration.
export async function readMeetingContext(projectId: string, roomId: string) {
  const db = roomDatabase(projectId);
  const room = db.collection("rooms").doc(roomId);
  return db.runTransaction(
    async (tx) => {
      const settings = await tx.get(room);
      if (settings.get("status") !== "open") return null;
      const minutes = settings.get("minutes") as number;
      const { agenda, numberedParts } = storedAgenda(settings, minutes);
      const { parts } = schedule(agenda, minutes);
      const docs = await tx.get(
        room.collection("phaseNotes").orderBy("createdAt", "desc").limit(32),
      );
      const notes = docs.docs
        .reverse()
        .map((d) => readNote(d.data(), numberedParts));
      const serverNow = Date.now();
      const current = parts.find(
        (p) =>
          p.startsAt !== null &&
          p.endsAt !== null &&
          p.startsAt <= serverNow &&
          serverNow < p.endsAt,
      );
      const boundary = parts
        .flatMap((p) => [p.startsAt, p.endsAt])
        .filter((t): t is number => t !== null && t > serverNow);
      const research = storedResearch(settings);
      return {
        topic: settings.get("topic"),
        minutes,
        version: agenda.version,
        planVersion: agenda.planVersion,
        planningAt: agenda.planningAt,
        parts,
        notes,
        ...(research.length > 0 && {
          research: research
            .filter((r) => r.status === "verified")
            .slice(-3)
            .map(({ question, finding }) => ({ question, finding })),
        }),
        currentPartId: current?.partId ?? null,
        serverNow,
        remainingSeconds: current?.endsAt
          ? Math.ceil((current.endsAt - serverNow) / 1000)
          : null,
        nextBoundary: boundary.length ? Math.min(...boundary) : null,
      };
    },
    { readOnly: true },
  );
}

function storedResearch(
  settings: FirebaseFirestore.DocumentSnapshot,
): Research[] {
  return settings.get("research") ?? [];
}

export async function transactResearch(
  projectId: string,
  roomId: string,
  command: ResearchCommand,
) {
  const db = roomDatabase(projectId);
  const room = db.collection("rooms").doc(roomId);
  return db.runTransaction(async (tx) => {
    const settings = await tx.get(room);
    const now = Date.now();
    if (settings.get("status") !== "open") return { status: "closed" };
    if (notebookAvailable(settings, now)) return { status: "ended" };
    const origin = storedAgenda(settings, settings.get("minutes"));
    const old = storedResearch(settings);
    const { rows, ...reply } = updateResearch(
      expireResearch(old, now),
      command,
      now,
    );
    if (rows !== old)
      tx.update(room, {
        research: rows,
        ...agendaFields(
          { ...origin.agenda, version: origin.agenda.version + 1 },
          origin,
        ),
      });
    return reply;
  });
}

export async function roomAgenda(
  projectId: string,
  uid: string,
  roomId: string,
  since: number | null,
  command?: AgendaCommand,
) {
  const db = roomDatabase(projectId);
  const room = db.collection("rooms").doc(roomId);
  return db.runTransaction(async (tx) => {
    const { settings, minutes, open, joined } = await readAgendaRoom(
      tx,
      room,
      uid,
    );
    const denied = agendaAccessError({ open, joined });
    if (denied) return { error: denied };
    const origin = storedAgenda(settings, minutes);
    const { migrateOnRead, agenda, numberedParts } = origin;
    let pending = settings.get("pendingAgendaProposal") as
      Pending | null | undefined;
    let notice = settings.get("proposalNotice") as
      ProposalNotice | null | undefined;
    const now = Date.now();
    const originalResearch = storedResearch(settings);
    const research = expireResearch(originalResearch, now);
    let toSave =
      research !== originalResearch
        ? { ...agenda, version: agenda.version + 1 }
        : agenda;
    // Old unversioned notices cannot be attributed to the current plan. Bump
    // the display revision so tabs with a cached notice also remove it.
    if (
      notice &&
      (notice.planVersion !== agenda.planVersion || !(notice.expiresAt > now))
    ) {
      notice = null;
      toSave = { ...agenda, version: agenda.version + 1 };
    }
    if (pending) {
      const checked = evaluateProposal(agenda, pending.proposal, minutes, now);
      if (typeof checked === "string") {
        notice = proposalNotice(
          pending.proposal.id,
          checked,
          agenda.planVersion,
          now,
        );
        pending = null;
        toSave = { ...agenda, version: agenda.version + 1 };
      }
    }
    const beforeCommand = toSave;
    const result = await accessAgenda(
      {
        open,
        joined,
        owner: settings.get("ownerUid") === uid,
        minutes,
        agenda: beforeCommand,
      },
      {
        ...phaseNotes(tx, room, numberedParts),
        save: (updated) => {
          toSave = updated;
        },
      },
      now,
      migrateOnRead ? null : since,
      command,
    );
    if ("value" in result && (toSave !== agenda || migrateOnRead)) {
      if (pending && toSave.planVersion !== pending.proposal.basePlanVersion) {
        notice = proposalNotice(
          pending.proposal.id,
          "agenda-stale",
          toSave.planVersion,
          now,
        );
        pending = null;
      }
      if (notice && notice.planVersion !== toSave.planVersion) notice = null;
      tx.update(room, {
        ...agendaFields(toSave, origin),
        ...(research !== originalResearch && { research }),
        ...(pending === null && { pendingAgendaProposal: null }),
        ...(notice !== undefined && { proposalNotice: notice }),
      });
    }
    if (result.value && "parts" in result.value) {
      const applied = settings.get("lastAppliedProposal");
      return {
        ...result,
        value: {
          ...result.value,
          research: publicResearch(research),
          ...(pending && {
            proposal: {
              id: pending.proposal.id,
              reason: pending.proposal.reason,
              changes: pending.changes,
            },
          }),
          ...(applied?.planVersion === toSave.planVersion && {
            appliedProposal: {
              reason: applied.reason,
              changes: applied.changes,
            },
          }),
          ...(notice && { proposalStatus: notice.status }),
        },
      };
    }
    return result;
  });
}

function phaseNotes(
  tx: Transaction,
  room: DocumentReference,
  numberedParts: string[],
) {
  const notes = room.collection("phaseNotes");
  return {
    notes: async () =>
      (await tx.get(notes.orderBy("createdAt"))).docs.map((doc) =>
        readNote(doc.data(), numberedParts),
      ),
    note: async (id: string) => {
      const data = (await tx.get(notes.doc(id))).data();
      return data ? readNote(data, numberedParts) : null;
    },
    append: (id: string, note: PhaseNote) => {
      tx.create(notes.doc(id), {
        ...note,
        createdAt: FieldValue.serverTimestamp(),
      });
    },
  };
}

export async function appendWorkerNote(
  projectId: string,
  roomId: string,
  command: NoteCommand,
) {
  const db = roomDatabase(projectId);
  const room = db.collection("rooms").doc(roomId);
  return db.runTransaction(async (tx) => {
    const settings = await tx.get(room);
    if (settings.get("status") !== "open") return { error: "closed" } as const;
    const minutes = settings.get("minutes") as number;
    const origin = storedAgenda(settings, minutes);
    return appendPhaseNote(
      origin.agenda,
      minutes,
      {
        ...phaseNotes(tx, room, origin.numberedParts),
        save: (updated) => {
          tx.update(room, agendaFields(updated, origin));
        },
      },
      Date.now(),
      command,
    );
  });
}

export function notebookAvailable(
  settings: FirebaseFirestore.DocumentSnapshot,
  now: number,
) {
  if (settings.get("status") !== "open") return true;
  const minutes = settings.get("minutes") as number;
  const { agenda } = storedAgenda(settings, minutes);
  const { endsAt } = schedule(agenda, minutes);
  return endsAt !== null && now >= endsAt;
}

export async function readRoomNotebook(
  projectId: string,
  uid: string,
  roomId: string,
) {
  const db = roomDatabase(projectId);
  const room = db.collection("rooms").doc(roomId);
  return db.runTransaction(
    async (tx) => {
      const [settings, member] = await tx.getAll(
        room,
        room.collection("members").doc(uid),
      );
      if (!settings!.exists || !member!.exists)
        return { error: "not-member" } as const;
      if (!notebookAvailable(settings!, Date.now()))
        return { error: "meeting-in-progress" } as const;
      const { agenda, numberedParts } = storedAgenda(
        settings!,
        settings!.get("minutes"),
      );
      const notes = await phaseNotes(tx, room, numberedParts).notes();
      return {
        value: {
          topic: settings!.get("topic") as string,
          research: publicResearch(
            storedResearch(settings!).filter(
              (r) => r.status === "verified" || r.status === "unverified",
            ),
          ),
          parts: withPhaseNotes(agenda.parts, notes),
        },
      };
    },
    { readOnly: true },
  );
}
