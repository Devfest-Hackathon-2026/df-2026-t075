export function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
export function shortText(input: unknown, limit: number): input is string {
  return typeof input === "string" && !!input.trim() && input.length <= limit;
}
