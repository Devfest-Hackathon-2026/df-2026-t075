import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startServer } from "./standalone-server.mjs";

test(
  "Next.js writes, reads back and removes a unique marker in the deployed SQL Connect database",
  { timeout: 120_000 },
  async (t) => {
    assert.ok(
      !process.env.DATA_CONNECT_EMULATOR_HOST,
      "This check requires real SQL Connect.",
    );
    const { projects } = JSON.parse(
      await readFile(new URL("../../.firebaserc", import.meta.url), "utf8"),
    );
    const token = randomBytes(32).toString("hex");
    const server = await startServer(t, {
      GOOGLE_CLOUD_PROJECT: projects.default,
      DB_CHECK_TOKEN: token,
    });
    await server.waitFor(() =>
      server.events().some((event) => event.event === "runtime.started"),
    );
    const response = await fetch(
      new URL("/api/internal/db-check", server.url),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(90_000),
      },
    );
    assert.equal(
      response.status,
      200,
      `DB check failed (request ${response.headers.get("x-request-id")}).`,
    );
    assert.deepEqual(await response.json(), {
      status: "ok",
      kind: "database-roundtrip",
    });
  },
);
