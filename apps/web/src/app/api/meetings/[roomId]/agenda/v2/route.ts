import { handleAgenda } from "@/server/composition/rooms.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function agenda(
  request: Request,
  context: RouteContext<"/api/meetings/[roomId]/agenda/v2">,
) {
  return handleAgenda(request, (await context.params).roomId, "fixed-id");
}

export const GET = agenda;
export const POST = agenda;
