import { describe, expect, it, vi } from "vitest";
import { resolveRequestId } from "./request-id";

describe("request IDs", () => {
  it("preserves a bounded, printable correlation ID", () => {
    const generate = vi.fn(() => "new-id");
    expect(resolveRequestId("request_123-abc", generate)).toBe(
      "request_123-abc",
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([null, "", "a".repeat(65), "line\nbreak", "空白", " has-space"])(
    "replaces an unsafe or missing header %j",
    (candidate) => {
      expect(resolveRequestId(candidate, () => "generated-id")).toBe(
        "generated-id",
      );
    },
  );

  it("generates a UUID when no correlation ID is supplied", () => {
    expect(resolveRequestId(null)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
