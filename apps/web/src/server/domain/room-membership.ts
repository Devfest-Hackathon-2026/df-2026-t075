import { isUuidV4 } from "@/server/domain/uuid";
export type RoomSettings = { topic: string; minutes: number; member: string };
export type NewRoom = RoomSettings & { roomId: string };
export type Membership = { joined: boolean; version: number };
export type MembershipChange = { join: boolean; version: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNewRoom(value: unknown): NewRoom | null {
  if (!record(value)) return null;
  const { roomId, topic, minutes, member } = value;
  if (
    !isUuidV4(roomId) ||
    typeof topic !== "string" ||
    !topic.trim() ||
    topic.trim().length > 100 ||
    typeof minutes !== "number" ||
    ![15, 30, 45, 60].includes(minutes) ||
    typeof member !== "string" ||
    !["ノト", "ピコ", "ロロ"].includes(member)
  )
    return null;
  return { roomId, topic: topic.trim(), minutes, member };
}

export function readMembershipChange(value: unknown): MembershipChange | null {
  if (!record(value)) return null;
  const { action, version } = value;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    return null;
  if (action === "leave") return { join: false, version };
  if (
    action === "join" &&
    value.adultConfirmed === true &&
    value.transcriptionConsent === true
  )
    return { join: true, version };
  return null;
}

export function membershipTransition(
  current: Membership,
  change: MembershipChange,
  open: boolean,
): "apply" | "unchanged" | "closed" | "stale" | "not-member" {
  if (change.join && !open) return "closed";
  if (!change.join && current.version === 0) return "not-member";
  if (change.join === current.joined) return "unchanged";
  return current.version === change.version ? "apply" : "stale";
}
