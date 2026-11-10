import "server-only";
import { isUuidV4OrV5 } from "@/server/domain/uuid";
import { isUuidV4 } from "@/server/domain/uuid";
import {
  readMembershipChange,
  readNewRoom,
} from "@/server/domain/room-membership";
import {
  accessRoom,
  admitRoomVoice,
  createRoom,
  listRooms,
} from "@/server/infrastructure/firestore/rooms";
import {
  issueMapTicket,
  roomMapAvailable,
} from "@/server/infrastructure/firestore/meeting-map";
import { withGoogleUser } from "./auth.server";
import { readAgendaCommand } from "@/server/domain/meeting-agenda";
import {
  readRoomNotebook,
  roomAgenda,
  transactProposal,
  legacyRoomAgenda,
  reloadAgendaMessage,
} from "@/server/infrastructure/firestore/meeting-agenda";
import { liveKitConfig } from "@/server/infrastructure/livekit/config";
import {
  issueMeetingVoice,
  disconnectMeetingMember,
} from "@/server/infrastructure/livekit/meeting-voice";

const errors = {
  missing: 404,
  "meeting-in-progress": 409,
  "map-offline": 503,
  closed: 409,
  stale: 409,
  conflict: 409,
  "not-member": 403,
  "host-only": 403,
  "agenda-stale": 409,
  "reload-required": 409,
  "over-total": 400,
  "reflection-fixed": 400,
  "part-ended": 400,
  "current-part-moved": 400,
  "current-ends-too-soon": 400,
  "duplicate-part": 400,
  "unknown-part": 400,
  limited: 429,
  unavailable: 503,
  "voice-disconnect": 503,
} as const;

function respond(result: { value: unknown } | { error: keyof typeof errors }) {
  if ("value" in result) return Response.json(result.value);
  return Response.json(
    result.error === "reload-required"
      ? { code: result.error, message: reloadAgendaMessage }
      : { code: result.error },
    { status: errors[result.error] },
  );
}

export function handleRooms(request: Request) {
  return withGoogleUser(request, async ({ uid }, projectId) => {
    if (request.method !== "POST")
      return Response.json(await listRooms(projectId, uid));
    const settings = readNewRoom(await request.json().catch(() => null));
    if (!settings) return new Response(null, { status: 400 });
    return respond(await createRoom(projectId, uid, settings));
  });
}

export function handleAgenda(
  request: Request,
  roomId: string,
  protocol: "legacy" | "fixed-id",
) {
  return withGoogleUser(request, async ({ uid }, projectId) => {
    if (!isUuidV4(roomId)) return new Response(null, { status: 404 });
    if (protocol === "legacy")
      return respond(
        await legacyRoomAgenda(
          projectId,
          uid,
          roomId,
          request.method === "POST" ? "POST" : "GET",
        ),
      );
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (body?.action === "approve" || body?.action === "dismiss") {
        if (!isUuidV4OrV5(body.id)) return new Response(null, { status: 400 });
        const result = await transactProposal(projectId, roomId, {
          uid,
          id: body.id,
          ...(body.action === "dismiss" && { dismiss: true }),
        });
        if (result.error)
          return Response.json(
            { code: result.error },
            { status: result.error === "not-member" ? 403 : 409 },
          );
        return result.value?.status ===
          (body.action === "dismiss" ? "dismissed" : "applied")
          ? Response.json({ saved: true })
          : Response.json({ code: result.value?.status }, { status: 409 });
      }
      const command = readAgendaCommand(body);
      if (!command) return new Response(null, { status: 400 });
      if (command === "reload-required")
        return respond(await legacyRoomAgenda(projectId, uid, roomId, "POST"));
      return respond(await roomAgenda(projectId, uid, roomId, null, command));
    }
    const version = new URL(request.url).searchParams.get("since");
    return respond(
      await roomAgenda(
        projectId,
        uid,
        roomId,
        version === null ? null : Number(version),
      ),
    );
  });
}

export function handleMembership(request: Request, code: string) {
  return withGoogleUser(request, async ({ uid }, projectId) => {
    if (!/^[A-Z0-9]{6}$/.test(code) || code === "AINOTE")
      return new Response(null, { status: 404 });
    const changing = request.method === "PUT";
    const change = changing
      ? readMembershipChange(await request.json().catch(() => null))
      : null;
    if (changing && !change) return new Response(null, { status: 400 });
    let result = await accessRoom(projectId, uid, code, change ?? undefined);
    const config = liveKitConfig(process.env);
    if (result.value && result.disconnectVersion !== undefined && change) {
      if (!config) return respond({ error: "voice-disconnect" });
      try {
        await disconnectMeetingMember(
          config,
          result.value.roomId,
          uid,
          result.disconnectVersion,
        );
      } catch {
        return respond({ error: "voice-disconnect" });
      }
      result = await accessRoom(
        projectId,
        uid,
        code,
        change,
        result.disconnectVersion,
      );
    }
    if (!result.value) return respond({ error: result.error });
    return Response.json({
      ...result.value,
      mapAvailable:
        result.value.open &&
        !result.value.leaving &&
        (await roomMapAvailable(projectId, result.value.roomId)),
      voiceAvailable: Boolean(
        config && process.env.MEETING_VOICE_ENABLED === "1",
      ),
    });
  });
}

export function handleMeetingVoice(request: Request, roomId: string) {
  return withGoogleUser(request, async (user, projectId) => {
    if (!isUuidV4(roomId) || process.env.MEETING_VOICE_ENABLED !== "1")
      return new Response(null, { status: 404 });
    const config = liveKitConfig(process.env);
    if (!config) return respond({ error: "unavailable" });
    const result = await admitRoomVoice(projectId, user.uid, roomId);
    if (!result.value) return respond({ error: result.error });
    return Response.json(
      await issueMeetingVoice(
        config,
        roomId,
        user.uid,
        result.value.version,
        user.displayName,
        result.value.member,
      ),
    );
  });
}

export function handleRoomNotebook(request: Request, roomId: string) {
  return withGoogleUser(request, async ({ uid }, project) => {
    if (!isUuidV4(roomId)) return new Response(null, { status: 404 });
    return respond(await readRoomNotebook(project, uid, roomId));
  });
}

export function handleMeetingMap(request: Request, roomId: string) {
  return withGoogleUser(request, async (user, projectId) => {
    if (!isUuidV4(roomId)) return new Response(null, { status: 404 });
    const result = await issueMapTicket(projectId, roomId, user);
    const reply = respond(result);
    reply.headers.set("Cache-Control", "private, no-store");
    return reply;
  });
}
