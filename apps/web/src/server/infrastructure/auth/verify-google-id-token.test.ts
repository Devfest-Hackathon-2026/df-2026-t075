import { FirebaseAuthError } from "firebase-admin/auth";
import type * as AdminAuth from "firebase-admin/auth";
import { describe, expect, it, vi } from "vitest";
import { verifyGoogleIdToken } from "./verify-google-id-token";

const verify = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("firebase-admin/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AdminAuth>()),
  getAuth: () => ({ verifyIdToken: verify }),
}));

describe("Google ID token verification", () => {
  it.each([
    ["参加者", "参加者"],
    [undefined, null],
  ])(
    "uses the verified uid and initial display name",
    async (name, expected) => {
      verify.mockResolvedValueOnce({
        uid: "account-1",
        name,
        firebase: { sign_in_provider: "google.com" },
      });
      await expect(
        verifyGoogleIdToken("test-token", "demo-meeting-auth"),
      ).resolves.toEqual({ uid: "account-1", displayName: expected });
      expect(verify).toHaveBeenCalledWith("test-token");
    },
  );

  it("rejects sign-in through another provider", async () => {
    verify.mockResolvedValueOnce({
      uid: "account-2",
      firebase: { sign_in_provider: "anonymous" },
    });
    await expect(
      verifyGoogleIdToken("test-token", "demo-meeting-auth"),
    ).resolves.toBeNull();
  });

  it("distinguishes expired credentials from a service failure", async () => {
    verify.mockRejectedValueOnce(
      new FirebaseAuthError({ code: "id-token-expired", message: "expired" }),
    );
    await expect(
      verifyGoogleIdToken("test-token", "demo-meeting-auth"),
    ).resolves.toBeNull();
    verify.mockRejectedValueOnce(new Error("service unavailable"));
    await expect(
      verifyGoogleIdToken("test-token", "demo-meeting-auth"),
    ).rejects.toThrow("service unavailable");
  });
});
