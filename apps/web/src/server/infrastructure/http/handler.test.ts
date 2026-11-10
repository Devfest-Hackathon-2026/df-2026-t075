import { describe, expect, it, vi } from "vitest";
import { createHttpHandler } from "./handler";

describe("HTTP boundary", () => {
  it("preserves a successful response and adds request correlation without caching", async () => {
    const log = vi.fn();
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(112);
    const handler = createHttpHandler(
      () =>
        Response.json({ status: "ok" }, { headers: { "x-example": "kept" } }),
      { logger: { log }, now },
    );

    const response = await handler(
      new Request("https://example.test/api/health?token=secret", {
        headers: {
          "x-request-id": "request-1",
          authorization: "Bearer secret",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-example")).toBe("kept");
    expect(log).toHaveBeenCalledExactlyOnceWith("info", {
      event: "http.request.completed",
      requestId: "request-1",
      method: "GET",
      statusCode: 200,
      durationMs: 12,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("returns a stable error and never exposes the original exception", async () => {
    const log = vi.fn();
    const handler = createHttpHandler(
      () => {
        throw new Error("postgres://user:secret@internal-host/database");
      },
      { logger: { log }, now: () => 0 },
    );

    const response = await handler(
      new Request("https://example.test/api/health"),
    );
    const body = await response.json();
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(500);
    expect(requestId).toBeTruthy();
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        requestId,
      },
    });
    expect(JSON.stringify([body, log.mock.calls])).not.toContain("secret");
    expect(JSON.stringify([body, log.mock.calls])).not.toContain(
      "internal-host",
    );
    expect(log).toHaveBeenCalledWith("error", {
      event: "http.request.completed",
      requestId,
      method: "GET",
      statusCode: 500,
      durationMs: 0,
      errorCode: "INTERNAL_ERROR",
    });
  });

  it("bounds untrusted method names in logs", async () => {
    const log = vi.fn();
    const handler = createHttpHandler(
      () => new Response(null, { status: 204 }),
      {
        logger: { log },
      },
    );
    const response = await handler(
      new Request("https://example.test/api/health", {
        method: "custom-method",
      }),
    );
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({ method: "OTHER" }),
    );
  });
});
