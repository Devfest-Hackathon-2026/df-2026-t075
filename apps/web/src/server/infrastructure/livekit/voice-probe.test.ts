import { describe, expect, it } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";
import { issueVoiceProbe } from "./voice-probe";

const env = {
  VOICE_PROBE_TOKEN: "operator-".repeat(6),
  LIVEKIT_URL: "wss://example.invalid",
  LIVEKIT_API_KEY: "test-key",
  LIVEKIT_API_SECRET: "signing-".repeat(6),
};
function request(
  key = env.VOICE_PROBE_TOKEN,
  body = JSON.stringify({ adultAndConsenting: true }),
) {
  return new Request("http://localhost/api/internal/voice-probe", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body,
  });
}
describe("operator voice probe", () => {
  it("signs a short-lived microphone-only grant for a different room on each run", async () => {
    const verifier = new TokenVerifier(
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
    const join = async () => {
      const response = await issueVoiceProbe(request(), env);
      const data = await response.json();
      expect(Object.keys(data).sort()).toEqual(["token", "url"]);
      return verifier.verify(data.token);
    };
    const first = await join();
    expect(first.video).toEqual({
      room: expect.stringMatching(/^voice-probe-/),
      roomJoin: true,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: ["microphone"],
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(first.roomConfig?.agents[0]?.agentName).toBe("ainote-voice-probe");
    expect(first.video?.room).not.toBe((await join()).video?.room);
    expect(first.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(90);
  });
  it("requires both the operator secret and explicit adult transcription consent", async () => {
    expect((await issueVoiceProbe(request(), {})).status).toBe(404);
    expect(
      (
        await issueVoiceProbe(
          request("a".repeat(env.VOICE_PROBE_TOKEN.length)),
          env,
        )
      ).status,
    ).toBe(404);
    expect((await issueVoiceProbe(request("x"), env)).status).toBe(404);
    for (const body of [
      "bad JSON",
      "{}",
      "false",
      '{"adultAndConsenting":"true"}',
    ]) {
      expect(
        (await issueVoiceProbe(request(undefined, body), env)).status,
      ).toBe(400);
    }
  });
  it.each([
    "http://localhost",
    "ws://example.invalid",
    "wss://u:p@example.invalid",
    "wss://example.invalid?secret=x",
    "",
  ])("refuses unusable or credential-bearing URLs", async (url) => {
    const response = await issueVoiceProbe(request(), {
      ...env,
      LIVEKIT_URL: url,
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });
  it("allows a local LiveKit server and refuses missing signing credentials", async () => {
    expect(
      (
        await issueVoiceProbe(request(), {
          ...env,
          LIVEKIT_URL: "ws://127.0.0.1:7880",
        })
      ).status,
    ).toBe(200);
    expect(
      (await issueVoiceProbe(request(), { ...env, LIVEKIT_API_SECRET: "" }))
        .status,
    ).toBe(503);
  });
});
