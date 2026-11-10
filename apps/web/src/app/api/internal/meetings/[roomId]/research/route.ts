import { handleWorkerResearch } from "@/server/composition/worker-context.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/internal/meetings/[roomId]/research">,
) {
  return handleWorkerResearch(request, (await context.params).roomId);
}
