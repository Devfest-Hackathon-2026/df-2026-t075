import { handleWorkerNote } from "@/server/composition/worker-context.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/internal/meetings/[roomId]/notes">,
) {
  return handleWorkerNote(request, (await context.params).roomId);
}
