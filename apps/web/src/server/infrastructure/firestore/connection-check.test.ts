import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyFirestoreEvent } from "./connection-check";

const doc = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  onSnapshot: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn() }));
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({ doc: () => doc }) }),
}));

describe("Firestore event roundtrip", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo-meeting-events");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("waits for its own acknowledgement and removes the listener and document", async () => {
    const stop = vi.fn();
    doc.onSnapshot.mockImplementationOnce((notify) => {
      notify({ get: () => undefined });
      notify({ get: () => doc.create.mock.calls[0]![0].challenge });
      return stop;
    });
    await verifyFirestoreEvent();
    expect(stop).toHaveBeenCalledOnce();
    expect(doc.delete).toHaveBeenCalledOnce();
  });

  it("times out on a missing or unrelated acknowledgement and still cleans up", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    doc.onSnapshot.mockImplementationOnce((notify) => {
      notify({ get: () => "another-request" });
      return stop;
    });
    const failure = expect(verifyFirestoreEvent()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(45_000);
    await failure;
    expect(stop).toHaveBeenCalledOnce();
    expect(doc.delete).toHaveBeenCalledOnce();
  });

  it("removes the probe after an uncertain write or failed subscription", async () => {
    doc.create.mockRejectedValueOnce(new Error("response lost"));
    await expect(verifyFirestoreEvent()).rejects.toThrow("response lost");
    expect(doc.onSnapshot).not.toHaveBeenCalled();
    doc.onSnapshot.mockImplementationOnce((_notify, fail) => {
      fail(new Error("subscription failed"));
      return vi.fn();
    });
    await expect(verifyFirestoreEvent()).rejects.toThrow("subscription failed");
    expect(doc.delete).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit project before accessing Firestore", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    await expect(verifyFirestoreEvent()).rejects.toThrow("project");
    expect(doc.create).not.toHaveBeenCalled();
  });
});
