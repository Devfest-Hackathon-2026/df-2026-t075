import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { confirmFirestoreCheck } from "../index.js";

function event(update, challenge = "unique-marker") {
  return {
    data: {
      get: (field) => (field === "challenge" ? challenge : undefined),
      ref: { update },
      updateTime: "creation-version",
    },
  };
}

test("acknowledges only the version that triggered the event", async () => {
  const update = mock.fn(async () => {});
  await confirmFirestoreCheck.run(event(update));
  assert.deepEqual(update.mock.calls[0].arguments, [
    { acknowledgement: "unique-marker" },
    { lastUpdateTime: "creation-version" },
  ]);
});

test("redelivery after an update or deletion is harmless", async () => {
  for (const code of [5, 9]) {
    await confirmFirestoreCheck.run(
      event(async () => {
        throw Object.assign(new Error("stale write"), { code });
      }),
    );
  }
});

test("invalid documents are ignored and operational errors report a generic failure", async () => {
  const update = mock.fn(async () => {
    throw new Error("private detail");
  });
  await confirmFirestoreCheck.run(event(update, null));
  assert.equal(update.mock.callCount(), 0);
  await assert.rejects(confirmFirestoreCheck.run(event(update)), {
    message: "The Firestore check could not be acknowledged.",
  });
});
