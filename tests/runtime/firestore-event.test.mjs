import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startServer } from "./standalone-server.mjs";

test(
  "Next.js receives an acknowledgement from the Firestore-triggered Function",
  {
    timeout: 120_000,
  },
  async (t) => {
    const emulator = process.env.FIRESTORE_TEST_MODE === "emulator";
    const { projects } = JSON.parse(
      await readFile(new URL("../../.firebaserc", import.meta.url), "utf8"),
    );
    const projectId = emulator
      ? "demo-meeting-events"
      : (process.env.GOOGLE_CLOUD_PROJECT ?? projects.default);
    if (emulator) {
      assert.equal(process.env.GCLOUD_PROJECT, projectId);
      assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
    } else {
      assert.ok(
        !process.env.FIRESTORE_EMULATOR_HOST,
        "This check requires live Firestore.",
      );
    }
    const token = randomBytes(32).toString("hex");
    const server = await startServer(t, {
      GOOGLE_CLOUD_PROJECT: projectId,
      DB_CHECK_TOKEN: token,
    });
    await server.waitFor(() =>
      server.events().some((event) => event.event === "runtime.started"),
    );
    const response = await fetch(
      new URL("/api/internal/function-check", server.url),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(90_000),
      },
    );
    assert.equal(
      response.status,
      200,
      `Function roundtrip failed (request ${response.headers.get("x-request-id")}).`,
    );
    assert.deepEqual(await response.json(), {
      status: "ok",
      kind: "firestore-event-roundtrip",
    });
    if (emulator) {
      const collection = new URL(
        `/v1/projects/${projectId}/databases/(default)/documents/functionChecks`,
        `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
      );
      const denied = await fetch(collection);
      assert.equal(denied.status, 403, "clients must not read probe documents");
      const created = await fetch(collection, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fields: { challenge: { stringValue: "client" } },
        }),
      });
      assert.equal(
        created.status,
        403,
        "clients must not enqueue probe events",
      );
      // The emulator's owner credential can inspect the isolated test database.
      const remaining = await fetch(collection, {
        headers: { authorization: "Bearer owner" },
      });
      assert.equal(remaining.status, 200);
      assert.equal((await remaining.json()).documents?.length ?? 0, 0);
    }
  },
);
