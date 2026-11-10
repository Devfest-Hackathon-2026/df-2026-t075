import { describe, expect, it, vi } from "vitest";
import {
  RoomServiceClient,
  ServerError,
  TokenVerifier,
} from "livekit-server-sdk";
import { disconnectMeetingMember, issueMeetingVoice } from "./meeting-voice";

const config = {
  url: "wss://example.invalid",
  key: "test",
  secret: "testing-".repeat(5),
};
const verifier = new TokenVerifier(config.key, config.secret);
const room = "2495a326-91fe-4a3d-931e-4593f77fabd2";
async function claims(uid: string, version: number) {
  const response = await issueMeetingVoice(
    config,
    room,
    uid,
    version,
    null,
    "ピコ",
  );
  return verifier.verify(response.token);
}

describe("member voice admission", () => {
  it("admits distinct people to one room with microphone, camera and control messages", async () => {
    const a = await claims("first", 1);
    const b = await claims("second", 1);
    expect(a.video).toEqual({
      room: "meeting-" + room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: ["microphone", "camera"],
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    expect(b.video?.room).toBe(a.video?.room);
    expect(a.sub).not.toBe(b.sub);
    expect(a.sub).toMatch(/^member-[a-f0-9]{64}-1$/);
    expect(a.roomConfig?.agents[0]).toMatchObject({
      agentName: "ainote-meeting",
      metadata: "ピコ",
    });
    expect(a.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30);
  });
  it("evicts exactly the departing visit and tolerates an already disconnected member", async () => {
    const first = await claims("first", 1);
    expect((await claims("first", 3)).sub).not.toBe(first.sub);
    const remove = vi
      .spyOn(RoomServiceClient.prototype, "removeParticipant")
      .mockResolvedValue();
    await disconnectMeetingMember(config, room, "first", 1);
    expect(remove).toHaveBeenCalledWith("meeting-" + room, first.sub, {
      revokeTokenTs: expect.any(BigInt),
    });
    remove.mockRejectedValueOnce(
      new ServerError("Not found", "", 404, "not_found"),
    );
    await disconnectMeetingMember(config, room, "first", 1);
    remove.mockRejectedValueOnce(new Error("test"));
    await expect(
      disconnectMeetingMember(config, room, "first", 1),
    ).rejects.toThrow();
  });
});
