import { randomUUID } from "node:crypto";
import {
  AccessToken,
  RoomConfiguration,
  TrackSource,
} from "livekit-server-sdk";
import { isOperator } from "../http/operator";
import { liveKitConfig } from "./config";

export async function issueVoiceProbe(
  request: Request,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Response> {
  if (!isOperator(request, env.VOICE_PROBE_TOKEN))
    return new Response(null, { status: 404 });
  const consent: unknown = await request.json().catch(() => null);
  if (
    !consent ||
    typeof consent !== "object" ||
    !("adultAndConsenting" in consent) ||
    consent.adultAndConsenting !== true
  ) {
    return new Response(null, { status: 400 });
  }
  const config = liveKitConfig(env);
  if (!config) {
    return new Response(null, { status: 503 });
  }
  const token = new AccessToken(config.key, config.secret, {
    identity: "probe-speaker",
    ttl: 90,
  });
  token.addGrant({
    roomJoin: true,
    room: `voice-probe-${randomUUID()}`,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  token.roomConfig = new RoomConfiguration({
    maxParticipants: 2,
    emptyTimeout: 30,
    departureTimeout: 5,
    agents: [{ agentName: "ainote-voice-probe" }],
  });
  return Response.json({ url: config.url, token: await token.toJwt() });
}
