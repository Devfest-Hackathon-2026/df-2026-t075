import { OAuth2Client, LoginTicket } from "google-auth-library";
import { expect, it, vi } from "vitest";
import { verifyWorker } from "./worker-token";

vi.mock("server-only", () => ({}));
it("checks the Google signature, audience, verified email and issuer before allowing room context", async () => {
  const verify = vi.spyOn(OAuth2Client.prototype, "verifyIdToken");
  const email = "worker@example.iam.gserviceaccount.com";
  const base = {
    email,
    email_verified: true,
    iss: "https://accounts.google.com",
    aud: "service",
    sub: "1",
    iat: 1,
    exp: 2,
  };
  for (const [change, allowed] of [
    [{}, true],
    [{ email: "other" }, false],
    [{ email_verified: false }, false],
    [{ iss: "other" }, false],
  ] as const) {
    verify.mockImplementation(
      async () => new LoginTicket("", { ...base, ...change }),
    );
    expect(await verifyWorker("token", "service", email)).toBe(allowed);
    expect(verify).toHaveBeenCalledWith({
      idToken: "token",
      audience: "service",
    });
  }
  verify.mockRejectedValue(new Error("bad token"));
  expect(await verifyWorker("token", "service", email)).toBe(false);
});
