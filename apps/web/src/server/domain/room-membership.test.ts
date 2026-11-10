import { describe, expect, it } from "vitest";
import {
  membershipTransition,
  readMembershipChange,
  readNewRoom,
} from "./room-membership";

describe("room inputs", () => {
  const room = {
    roomId: "2495a326-91fe-4a3d-931e-4593f77fabd2",
    topic: " お題 ",
    minutes: 15,
    member: "ピコ",
  };
  it("accepts the room form and trims the topic", () => {
    expect(readNewRoom(room)).toEqual({ ...room, topic: "お題" });
  });
  it.each([
    null,
    [],
    { ...room, roomId: "a/b" },
    { ...room, topic: 1 },
    { ...room, topic: " " },
    { ...room, topic: "x".repeat(101) },
    { ...room, minutes: "15" },
    { ...room, minutes: 2 },
    { ...room, member: "別" },
  ])("rejects invalid room settings", (value) => {
    expect(readNewRoom(value)).toBeNull();
  });
  it("checks both entry conditions for every admission", () => {
    const join = {
      action: "join",
      version: 0,
      adultConfirmed: true,
      transcriptionConsent: true,
    };
    expect(readMembershipChange(join)).toEqual({ join: true, version: 0 });
    for (const invalid of [
      null,
      { ...join, adultConfirmed: false },
      { ...join, transcriptionConsent: false },
      { ...join, version: -1 },
      { ...join, version: "1" },
      { ...join, action: "other" },
    ])
      expect(readMembershipChange(invalid)).toBeNull();
    expect(readMembershipChange({ action: "leave", version: 1 })).toEqual({
      join: false,
      version: 1,
    });
  });
});

describe("membership transitions", () => {
  it("preserves history on retries and rejects obsolete departures after reentry", () => {
    const current = { joined: true, version: 3 };
    expect(
      membershipTransition(current, { join: true, version: 2 }, true),
    ).toBe("unchanged");
    expect(
      membershipTransition(current, { join: false, version: 1 }, true),
    ).toBe("stale");
    expect(
      membershipTransition(current, { join: false, version: 3 }, true),
    ).toBe("apply");
    expect(
      membershipTransition(
        { joined: false, version: 0 },
        { join: false, version: 0 },
        true,
      ),
    ).toBe("not-member");
    expect(
      membershipTransition(
        { joined: false, version: 2 },
        { join: true, version: 2 },
        false,
      ),
    ).toBe("closed");
  });
});
