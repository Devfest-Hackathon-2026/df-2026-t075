import "server-only";
import { readAgendaCommand } from "@/server/domain/meeting-agenda";
import { readResearchCommand } from "@/server/domain/meeting-research";
import { readProposal } from "@/server/domain/agenda-proposal";
import { isUuidV4 } from "@/server/domain/uuid";
import { verifyWorker } from "@/server/infrastructure/auth/worker-token";
import {
  readMeetingContext,
  appendWorkerNote,
  transactProposal,
  transactResearch,
} from "@/server/infrastructure/firestore/meeting-agenda";
import { createHttpHandler } from "@/server/infrastructure/http/handler";
import { getServerLogger } from "./runtime.server";

function withWorker(
  request: Request,
  roomId: string,
  run: (project: string) => Promise<Response>,
) {
  return createHttpHandler(
    async () => {
      if (process.env.MEETING_VOICE_ENABLED !== "1" || !isUuidV4(roomId))
        return new Response(null, { status: 404 });
      const token = /^Bearer ([^\s,]+)$/i.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!token) return new Response(null, { status: 401 });
      const {
        MEETING_WORKER_AUDIENCE: audience,
        MEETING_WORKER_EMAIL: email,
        GOOGLE_CLOUD_PROJECT: project,
      } = process.env;
      if (!audience || !email || !project)
        return new Response(null, { status: 503 });
      if (!(await verifyWorker(token, audience, email)))
        return new Response(null, { status: 403 });
      return run(project);
    },
    { logger: getServerLogger() },
  )(request);
}

export function handleWorkerContext(request: Request, roomId: string) {
  return withWorker(request, roomId, async (project) => {
    const state = await readMeetingContext(project, roomId);
    return state ? Response.json(state) : new Response(null, { status: 410 });
  });
}

export function handleWorkerProposal(request: Request, roomId: string) {
  return withWorker(request, roomId, async (project) => {
    const proposal = readProposal(await request.json().catch(() => null));
    if (!proposal)
      return Response.json({ status: "invalid-proposal" }, { status: 400 });
    const result = await transactProposal(project, roomId, { proposal });
    if (result.error === "closed") return new Response(null, { status: 410 });
    if (result.error)
      return Response.json({ status: result.error }, { status: 409 });
    return Response.json(result.value);
  });
}

export function handleWorkerNote(request: Request, roomId: string) {
  return withWorker(request, roomId, async (project) => {
    const command = readAgendaCommand(await request.json().catch(() => null));
    if (!command || command === "reload-required" || command.action !== "note")
      return Response.json({ status: "invalid-note" }, { status: 400 });
    const result = await appendWorkerNote(project, roomId, command);
    if (result.error === "closed") return new Response(null, { status: 410 });
    if (result.error)
      return Response.json({ status: result.error }, { status: 409 });
    return Response.json({ status: "saved" });
  });
}

export function handleWorkerResearch(request: Request, roomId: string) {
  return withWorker(request, roomId, async (project) => {
    const command = readResearchCommand(await request.json().catch(() => null));
    if (!command)
      return Response.json({ status: "invalid-research" }, { status: 400 });
    const result = await transactResearch(project, roomId, command);
    return result.status === "closed"
      ? new Response(null, { status: 410 })
      : Response.json(result);
  });
}
