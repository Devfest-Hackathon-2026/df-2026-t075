import { describe, expect, it, vi } from "vitest";
import { ensureUserProfile } from "./user-profile";

const tx = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "server-time" },
  getFirestore: () => ({
    collection: (name: string) => ({ doc: (id: string) => `${name}/${id}` }),
    runTransaction: (work: (transaction: typeof tx) => Promise<void>) =>
      work(tx),
  }),
}));

describe("Firestore user profiles", () => {
  it("initializes a missing profile and keeps subsequent visits read-only", async () => {
    tx.get
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true });
    await ensureUserProfile("demo-meeting-auth", "account-1", null);
    await ensureUserProfile("demo-meeting-auth", "account-1", "別の名前");
    expect(tx.create).toHaveBeenCalledExactlyOnceWith("users/account-1", {
      displayName: null,
      createdAt: "server-time",
    });
  });

  it("propagates a failed read so the client can retry initialization", async () => {
    tx.get.mockRejectedValueOnce(new Error("Firestore unavailable"));
    await expect(
      ensureUserProfile("demo-meeting-auth", "account-1", null),
    ).rejects.toThrow("Firestore unavailable");
    expect(tx.create).not.toHaveBeenCalled();
  });

  it("requires a UID identifying a single document", async () => {
    await expect(
      ensureUserProfile("demo-meeting-auth", "nested/path/id", null),
    ).rejects.toThrow("document ID");
    expect(tx.get).not.toHaveBeenCalled();
  });
});
