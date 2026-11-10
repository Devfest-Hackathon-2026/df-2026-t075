import { createHash } from "node:crypto";
import {
  AccessToken,
  RoomConfiguration,
  RoomServiceClient,
  ServerError,
  TrackSource,
} from "livekit-server-sdk";
import type { liveKitConfig } from "./config";

type Config = NonNullable<ReturnType<typeof liveKitConfig>>;

function memberIdentity(roomId: string, uid: string, version: number) {
  const hash = createHash("sha256")
    .update(roomId + ":" + uid)
    .digest("hex");
  return `member-${hash}-${version}`;
}

export async function issueMeetingVoice(
  config: Config,
  roomId: string,
  uid: string,
  version: number,
  displayName: string | null,
  member: string,
) {
  const token = new AccessToken(config.key, config.secret, {
    identity: memberIdentity(roomId, uid, version),
    name: displayName?.slice(0, 70) || "参加者",
    ttl: 30,
  });
  token.addGrant({
    roomJoin: true,
    room: "meeting-" + roomId,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  token.roomConfig = new RoomConfiguration({
    maxParticipants: 5,
    emptyTimeout: 30,
    departureTimeout: 10,
    agents: [{ agentName: "ainote-meeting", metadata: member }],
  });
  return { url: config.url, token: await token.toJwt() };
}

export async function disconnectMeetingMember(
  config: Config,
  roomId: string,
  uid: string,
  version: number,
) {
  const rooms = new RoomServiceClient(config.url, config.key, config.secret, {
    requestTimeout: 4,
  });
  try {
    await rooms.removeParticipant(
      "meeting-" + roomId,
      memberIdentity(roomId, uid, version),
      // JWT nbf is in whole seconds. This visit's identity is never reused after leaving.
      { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 1) },
    );
  } catch (error) {
    if (!(error instanceof ServerError && error.code === "not_found"))
      throw error;
  }
}
