import { handleRoomNotebook } from "@/server/composition/rooms.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: RouteContext<"/api/meetings/[roomId]/note">,
) {
  return handleRoomNotebook(request, (await context.params).roomId);
}
