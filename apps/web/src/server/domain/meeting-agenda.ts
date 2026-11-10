import { isUuidV4 } from "@/server/domain/uuid";
type PartFields = { name: string; minutes: number; aim?: string };
export type PartPlan = PartFields & { partId: string };
type PlanInput = PartFields & { partId: string | null };
export type Agenda = {
  version: number;
  planVersion: number;
  nextPartNumber: number;
  planningAt: number | null;
  confirmedAt: number | null;
  parts: PartPlan[];
};

export type AgendaCommand =
  | { action: "start" }
  | { action: "save" | "confirm"; planVersion: number; parts: PlanInput[] }
  | { action: "note"; id: string; partId: string; text: string };

const minute = 60_000;
const reflection = { name: "振り返り", minutes: 2 };

export function initialAgenda(minutes: number): Agenda {
  const first = Math.floor(minutes / 3);
  const parts = [
    { name: "考えを持ち寄る", minutes: first },
    { name: "アイデアを深める", minutes: minutes - first - 5 },
    { name: "次の一歩を決める", minutes: 3 },
    reflection,
  ].map((part, index) => ({ ...part, partId: `part-${index}` }));
  return {
    version: 0,
    planVersion: 0,
    nextPartNumber: parts.length,
    planningAt: null,
    confirmedAt: null,
    parts,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isPartId(value: unknown): value is string {
  return (
    typeof value === "string" && /^(part|legacy)-(0|[1-9]\d{0,15})$/.test(value)
  );
}

export function readAgendaCommand(
  value: unknown,
): AgendaCommand | "reload-required" | null {
  if (!record(value)) return null;
  const { action, planVersion, parts, id, partId, text } = value;
  if (action === "start") return { action };
  if (action === "note") {
    if (partId === undefined && nonnegative(value.part))
      return "reload-required";
    if (
      !isUuidV4(id) ||
      !isPartId(partId) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.trim().length > 180
    )
      return null;
    return { action, id, partId, text: text.trim() };
  }
  if (
    (action === "save" || action === "confirm") &&
    planVersion === undefined &&
    nonnegative(value.version)
  )
    return "reload-required";
  if (
    (action !== "save" && action !== "confirm") ||
    !nonnegative(planVersion) ||
    !Array.isArray(parts) ||
    parts.length < 2 ||
    parts.length > 60
  )
    return null;
  const plan: PlanInput[] = [];
  for (const row of parts) {
    if (!record(row)) return null;
    if (!("partId" in row)) return "reload-required";
    if (
      (row.partId !== null && !isPartId(row.partId)) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.trim().length > 40 ||
      !nonnegative(row.minutes) ||
      row.minutes < 1
    )
      return null;
    plan.push({
      partId: row.partId,
      name: row.name.trim(),
      minutes: row.minutes,
    });
  }
  return { action, planVersion, parts: plan };
}

export function isPreparing(agenda: Agenda, now: number) {
  return (
    agenda.planningAt !== null &&
    agenda.confirmedAt === null &&
    now < agenda.planningAt + 3 * minute
  );
}

// Deadlines are absolute so a room can advance even while every browser is closed.
export function schedule(agenda: Agenda, minutes: number) {
  const startsAt =
    agenda.confirmedAt ??
    (agenda.planningAt === null ? null : agenda.planningAt + 3 * minute);
  let elapsed = 0;
  const parts = agenda.parts.map((part) => {
    const partStart = startsAt === null ? null : startsAt + elapsed;
    elapsed += part.minutes * minute;
    return {
      ...part,
      startsAt: partStart,
      endsAt: startsAt === null ? null : startsAt + elapsed,
    };
  });
  return {
    startsAt,
    endsAt: startsAt === null ? null : startsAt + minutes * minute,
    parts,
  };
}

function samePart(left: PartPlan, right: PlanInput | undefined) {
  return (
    left.partId === right?.partId &&
    left.name === right.name &&
    left.minutes === right.minutes
  );
}

type TimelineError =
  "current-part-moved" | "current-ends-too-soon" | "part-ended";

// Compare against the committed timeline, including an automatic start while
// every browser was offline. Only future discussion parts can move or disappear.
export function timelineError(
  agenda: Agenda,
  parts: PlanInput[],
  minutes: number,
  now: number,
): TimelineError | null {
  const timeline = schedule(agenda, minutes);
  if (timeline.startsAt === null || now < timeline.startsAt) return null;
  for (const [index, old] of timeline.parts.entries()) {
    const next = parts[index];
    if (now < old.endsAt!) {
      if (old.partId !== next?.partId) return "current-part-moved";
      if (old.startsAt! + next.minutes * minute <= now)
        return "current-ends-too-soon";
      return null;
    }
    if (!samePart(old, next)) return "part-ended";
  }
  return parts.length === timeline.parts.length ? null : "part-ended";
}

export function updatePlan(
  agenda: Agenda,
  command: Exclude<AgendaCommand, { action: "note" }>,
  minutes: number,
  owner: boolean,
  now: number,
):
  | Agenda
  | "host-only"
  | "agenda-stale"
  | "over-total"
  | "reflection-fixed"
  | "duplicate-part"
  | "unknown-part"
  | TimelineError {
  const revisions = {
    version: agenda.version + 1,
    planVersion: agenda.planVersion + 1,
  };
  if (command.action === "start") {
    if (!owner) return "host-only";
    if (agenda.planningAt !== null) return agenda;
    return { ...agenda, planningAt: now, ...revisions };
  }
  if (
    agenda.planVersion !== command.planVersion ||
    agenda.planningAt === null ||
    (command.action === "confirm" && !isPreparing(agenda, now))
  )
    return "agenda-stale";
  if (command.parts.reduce((sum, p) => sum + p.minutes, 0) > minutes)
    return "over-total";
  // The final reflection keeps its identity when every discussion part is replaced.
  const last = command.parts.at(-1);
  if (
    last?.name !== reflection.name ||
    last.minutes !== reflection.minutes ||
    last.partId !== agenda.parts.at(-1)?.partId
  )
    return "reflection-fixed";
  const timeError = timelineError(agenda, command.parts, minutes, now);
  if (timeError) return timeError;
  if (
    command.action === "save" &&
    agenda.parts.length === command.parts.length &&
    agenda.parts.every((part, index) => samePart(part, command.parts[index]))
  )
    return agenda;
  const available = new Set(agenda.parts.map((part) => part.partId));
  let nextPartNumber = agenda.nextPartNumber;
  const parts: PartPlan[] = [];
  for (const row of command.parts) {
    if (row.partId !== null && !available.delete(row.partId))
      return agenda.parts.some((p) => p.partId === row.partId)
        ? "duplicate-part"
        : "unknown-part";
    // The manual editor only submits name and duration; retain the purpose of existing parts.
    const aim =
      row.aim ?? agenda.parts.find((p) => p.partId === row.partId)?.aim;
    parts.push({
      ...row,
      ...(aim && { aim }),
      partId: row.partId ?? `part-${nextPartNumber++}`,
    });
  }
  return {
    ...agenda,
    parts,
    nextPartNumber,
    ...revisions,
    confirmedAt: command.action === "confirm" ? now : agenda.confirmedAt,
  };
}
