import { describe, expect, it, vi } from "vitest";
import { createJsonLogger } from "./logging";

describe("JSON logging", () => {
  it("writes one structured record and excludes arbitrary extra fields", () => {
    const writeLine = vi.fn();
    const logger = createJsonLogger("info", writeLine, () => new Date(0));
    const event = {
      event: "http.request.completed" as const,
      requestId: "request-1",
      method: "GET",
      statusCode: 200,
      durationMs: 12,
      authorization: "Bearer secret",
      body: { password: "secret" },
      error: new Error("secret"),
    };

    logger.log("info", event);

    expect(writeLine).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        timestamp: "1970-01-01T00:00:00.000Z",
        severity: "INFO",
        service: "ai-classroom-web",
        event: "http.request.completed",
        requestId: "request-1",
        method: "GET",
        statusCode: 200,
        durationMs: 12,
      }),
    );
  });

  it("honors the configured severity while retaining errors", () => {
    const writeLine = vi.fn();
    const logger = createJsonLogger("warn", writeLine);
    logger.log("info", { event: "runtime.started" });
    logger.log("warn", { event: "http.request.completed", statusCode: 429 });
    logger.log("error", {
      event: "http.request.completed",
      statusCode: 500,
      errorCode: "INTERNAL_ERROR",
    });
    expect(writeLine).toHaveBeenCalledTimes(2);
    expect(
      writeLine.mock.calls.map(([line]) => JSON.parse(line).severity),
    ).toEqual(["WARN", "ERROR"]);
  });
});
