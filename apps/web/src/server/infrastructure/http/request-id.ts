import { randomUUID } from "node:crypto";

const validRequestId = /^[A-Za-z0-9_-]{1,64}$/;

export function resolveRequestId(
  candidate: string | null,
  generate: () => string = randomUUID,
): string {
  return candidate !== null && validRequestId.test(candidate)
    ? candidate
    : generate();
}
