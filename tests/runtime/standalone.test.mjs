import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { startServer } from "./standalone-server.mjs";

test("database diagnostics require the operator token and keep failures private", async (t) => {
  const token = randomBytes(32).toString("hex");
  const server = await startServer(t, {
    DB_CHECK_TOKEN: token,
    GOOGLE_CLOUD_PROJECT: "",
  });
  await server.waitFor(() =>
    server.events().some((event) => event.event === "runtime.started"),
  );
  for (const path of [
    "/api/internal/db-check",
    "/api/internal/function-check",
  ]) {
    const url = new URL(path, server.url);
    for (const headers of [
      {},
      { authorization: `Bearer ${"0".repeat(token.length)}` },
    ]) {
      const denied = await fetch(url, { method: "POST", headers });
      assert.equal(denied.status, 404);
    }
    const failure = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(failure.status, 500);
    assert.equal((await failure.json()).error.code, "INTERNAL_ERROR");
  }
  assert.ok(!server.output().includes(token));
});

test(
  "standalone logs startup once across initial and repeated route requests",
  { timeout: 30_000 },
  async (t) => {
    const server = await startServer(t);
    const startupEvents = () =>
      server.events().filter((event) => event.event === "runtime.started");
    await server.waitFor(() => startupEvents().length > 0);
    assert.equal(startupEvents().length, 1);

    for (const [index, method] of ["GET", "GET", "HEAD"].entries()) {
      const requestId = `runtime-check-${index}`;
      const response = await fetch(server.url, {
        method,
        headers: { "x-request-id": requestId },
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-request-id"), requestId);
      await response.text();
    }

    // Next.js handles unsupported methods before the application's HTTP wrapper.
    const unsupported = await fetch(server.url, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("x-request-id"), null);
    await unsupported.text();

    const requests = () =>
      server
        .events()
        .filter((event) => event.event === "http.request.completed");
    await server.waitFor(() => requests().length >= 3);
    assert.deepEqual(
      requests().map((event) => event.method),
      ["GET", "GET", "HEAD"],
    );
    assert.equal(startupEvents().length, 1, server.output());
  },
);

test(
  "standalone fails health for invalid configuration without exposing its value",
  { timeout: 30_000 },
  async (t) => {
    const rejectedValue = "private-invalid-log-level";
    const server = await startServer(t, { APP_LOG_LEVEL: rejectedValue });
    await server.waitFor(() => server.output().includes("APP_LOG_LEVEL"));
    const response = await fetch(server.url, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes(rejectedValue));
    assert.match(
      server.output(),
      /Invalid server configuration: APP_LOG_LEVEL/,
    );
    assert.ok(!server.output().includes(rejectedValue));
    assert.equal(server.events().length, 0);
  },
);
