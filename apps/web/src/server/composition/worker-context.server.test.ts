import { afterEach, expect, it, vi } from "vitest";
import {
  handleWorkerContext,
  handleWorkerProposal,
} from "./worker-context.server";
import { verifyWorker } from "@/server/infrastructure/auth/worker-token";
import {
  readMeetingContext,
  transactProposal,
} from "@/server/infrastructure/firestore/meeting-agenda";

vi.mock("server-only", () => ({}));
vi.mock("@/server/infrastructure/auth/worker-token", () => ({
  verifyWorker: vi.fn(),
}));
vi.mock("@/server/infrastructure/firestore/meeting-agenda", () => ({
  readMeetingContext: vi.fn(),
  transactProposal: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());
it("only reads open-room state after worker identity verification", async () => {
  const id = "2495a326-91fe-4a3d-931e-4593f77fabd2";
  const read = (token?: string, room = id) =>
    handleWorkerContext(
      new Request("https://test.invalid/", {
        headers: token ? { authorization: "Bearer " + token } : {},
      }),
      room,
    );
  vi.stubEnv("MEETING_VOICE_ENABLED", "0");
  expect((await read()).status).toBe(404);
  vi.stubEnv("MEETING_VOICE_ENABLED", "1");
  expect((await read(undefined, "other")).status).toBe(404);
  expect((await read()).status).toBe(401);
  vi.stubEnv("MEETING_WORKER_AUDIENCE", "");
  expect((await read("token")).status).toBe(503);
  vi.stubEnv("MEETING_WORKER_AUDIENCE", "service");
  vi.stubEnv("MEETING_WORKER_EMAIL", "worker@sample.iam.gserviceaccount.com");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo");
  vi.mocked(verifyWorker).mockResolvedValue(false);
  expect((await read("token")).status).toBe(403);
  expect(readMeetingContext).not.toHaveBeenCalled();
  vi.mocked(verifyWorker).mockResolvedValue(true);
  vi.mocked(readMeetingContext).mockResolvedValue(null);
  expect((await read("token")).status).toBe(410);
  vi.mocked(readMeetingContext).mockResolvedValue({
    topic: "合成",
    minutes: 15,
    version: 0,
    planVersion: 0,
    planningAt: null,
    parts: [],
    notes: [],
    currentPartId: null,
    serverNow: 1,
    remainingSeconds: null,
    nextBoundary: null,
  });
  const response = await read("token");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(readMeetingContext).toHaveBeenCalledWith("demo", id);
});

it("authenticates the worker before reading a proposal and passes only validated operations", async () => {
  const room = "2495a326-91fe-4a3d-931e-4593f77fabd2";
  const proposal = {
    id: room,
    basePlanVersion: 2,
    reason: "予算を確認",
    operations: [{ action: "rename", target: "legacy-2", name: "比較" }],
  };
  const send = (body: unknown) =>
    handleWorkerProposal(
      new Request("https://test.invalid/", {
        method: "POST",
        headers: { authorization: "Bearer test" },
        body: JSON.stringify(body),
      }),
      room,
    );
  vi.stubEnv("MEETING_VOICE_ENABLED", "1");
  vi.stubEnv("MEETING_WORKER_AUDIENCE", "service");
  vi.stubEnv("MEETING_WORKER_EMAIL", "worker@sample.iam.gserviceaccount.com");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo");
  vi.mocked(verifyWorker).mockResolvedValue(false);
  expect((await send(proposal)).status).toBe(403);
  vi.mocked(verifyWorker).mockResolvedValue(true);
  expect((await send({ ...proposal, operations: [] })).status).toBe(400);
  expect(transactProposal).not.toHaveBeenCalled();
  vi.mocked(transactProposal).mockResolvedValue({
    value: { status: "pending" },
  });
  expect(
    await (
      await send({ ...proposal, roomId: "untrusted", uid: "untrusted" })
    ).json(),
  ).toEqual({ status: "pending" });
  expect(transactProposal).toHaveBeenCalledWith("demo", room, { proposal });
  vi.mocked(transactProposal).mockResolvedValue({ error: "closed" });
  expect((await send(proposal)).status).toBe(410);
  vi.mocked(transactProposal).mockResolvedValue({ error: "call-conflict" });
  expect((await send(proposal)).status).toBe(409);
});
