import { handleMeetingVoice } from "@/server/composition/rooms.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/meetings/[roomId]/voice">,
) {
  return handleMeetingVoice(request, (await context.params).roomId);
}
