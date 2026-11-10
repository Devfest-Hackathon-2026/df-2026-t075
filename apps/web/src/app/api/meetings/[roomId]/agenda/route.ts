import { handleAgenda } from "@/server/composition/rooms.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function agenda(
  request: Request,
  context: RouteContext<"/api/meetings/[roomId]/agenda">,
) {
  return handleAgenda(request, (await context.params).roomId, "legacy");
}

export const GET = agenda;
export const POST = agenda;
