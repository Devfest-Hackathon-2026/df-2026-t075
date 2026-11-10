import { handleMeetingMap } from "@/server/composition/rooms.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/meetings/[roomId]/map">,
) {
  return handleMeetingMap(request, (await context.params).roomId);
}
