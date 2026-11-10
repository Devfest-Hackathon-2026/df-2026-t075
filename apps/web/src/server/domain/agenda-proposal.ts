import {
  updatePlan,
  timelineError,
  schedule,
  isPartId,
  type Agenda,
  type PartPlan,
} from "./meeting-agenda";

import { isUuidV4OrV5 } from "./uuid";
import { record, shortText } from "./input";
export type Operation =
  | {
      action: "add";
      target: string;
      name: string;
      aim: string;
      minutes: number;
    }
  | { action: "rename"; target: string; name: string }
  | { action: "resize"; target: string; minutes: number }
  | { action: "remove"; target: string };

export type Proposal = {
  source?: "automatic";
  id: string;
  basePlanVersion: number;
  operations: Operation[];
  reason: string;
};

function duration(input: unknown): input is number {
  return (
    typeof input === "number" &&
    Number.isInteger(input) &&
    input >= 1 &&
    input <= 60
  );
}

export function readProposal(input: unknown): Proposal | null {
  if (
    !record(input) ||
    !isUuidV4OrV5(input.id) ||
    (input.source !== undefined && input.source !== "automatic") ||
    typeof input.basePlanVersion !== "number" ||
    !Number.isSafeInteger(input.basePlanVersion) ||
    input.basePlanVersion < 0 ||
    !shortText(input.reason, 240) ||
    !Array.isArray(input.operations) ||
    !input.operations.length ||
    input.operations.length > 24
  )
    return null;
  const operations: Operation[] = [];
  for (const row of input.operations) {
    if (!record(row) || !isPartId(row.target)) return null;
    const { action, target } = row;
    if (action === "remove") operations.push({ action, target });
    else if (action === "rename" && shortText(row.name, 40))
      operations.push({ action, target, name: row.name.trim() });
    else if (action === "resize" && duration(row.minutes))
      operations.push({ action, target, minutes: row.minutes });
    else if (
      action === "add" &&
      shortText(row.name, 40) &&
      shortText(row.aim, 180) &&
      duration(row.minutes)
    )
      operations.push({
        action,
        target,
        name: row.name.trim(),
        aim: row.aim.trim(),
        minutes: row.minutes,
      });
    else return null;
  }
  return {
    id: input.id,
    ...(input.source === "automatic" && { source: "automatic" }),
    basePlanVersion: input.basePlanVersion,
    reason: input.reason.trim(),
    operations,
  };
}

// Replay the entire proposal on a copy. Only the Web assigns IDs to new rows.
export function evaluateProposal(
  agenda: Agenda,
  proposal: Proposal,
  minutes: number,
  now: number,
) {
  if (agenda.planningAt === null) return "not-planning";
  if (agenda.planVersion !== proposal.basePlanVersion) return "agenda-stale";
  const parts: (Omit<PartPlan, "partId"> & { partId: string | null })[] =
    agenda.parts.map((p) => ({ ...p }));
  const timeline = schedule(agenda, minutes);
  const lastEnd = timeline.parts.at(-1)?.endsAt;
  if (lastEnd != null && lastEnd <= now) return "meeting-ended";
  const ended = new Set(
    timeline.parts
      .filter((p) => p.endsAt !== null && p.endsAt <= now)
      .map((p) => p.partId),
  );
  const changes: string[] = [];
  for (const op of proposal.operations) {
    const i = parts.findIndex((p) => p.partId === op.target);
    const part = parts[i];
    if (!part) return "unknown-part";
    if (ended.has(op.target)) return "part-ended";
    if (part.partId === agenda.parts.at(-1)?.partId) return "reflection-fixed";
    switch (op.action) {
      case "add":
        parts.splice(i + 1, 0, {
          partId: null,
          name: op.name,
          aim: op.aim,
          minutes: op.minutes,
        });
        changes.push(
          `「${part.name}」の後に「${op.name}」を追加（${op.minutes}分）　ねらい：${op.aim}`,
        );
        break;
      case "resize":
        changes.push(`「${part.name}」 ${part.minutes}分 → ${op.minutes}分`);
        part.minutes = op.minutes;
        break;
      case "rename":
        changes.push(`「${part.name}」 → 「${op.name}」`);
        part.name = op.name;
        break;
      case "remove":
        parts.splice(i, 1);
        changes.push(`「${part.name}」（${part.minutes}分）を削除`);
        break;
    }
    const invalidTime = timelineError(agenda, parts, minutes, now);
    if (invalidTime) return invalidTime;
  }
  if (parts.length < 2) return "discussion-required";
  const updated = updatePlan(
    agenda,
    { action: "save", planVersion: proposal.basePlanVersion, parts },
    minutes,
    false,
    now,
  );
  if (typeof updated === "string") return updated;
  if (updated === agenda) return "no-change";
  return { updated, changes };
}
