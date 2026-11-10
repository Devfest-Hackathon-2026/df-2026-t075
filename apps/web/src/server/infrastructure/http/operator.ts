import { timingSafeEqual } from "node:crypto";

export function isOperator(
  request: Request,
  token: string | undefined,
): boolean {
  if (!token || token.length < 32) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const presented = Buffer.from(request.headers.get("authorization") ?? "");
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}
