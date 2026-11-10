import { handleWorkerContext } from "@/server/composition/worker-context.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/api/internal/meetings/[roomId]/context">,
) {
  return handleWorkerContext(request, (await context.params).roomId);
}
