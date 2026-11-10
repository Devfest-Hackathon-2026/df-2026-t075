import { handleMembership } from "@/server/composition/rooms.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function membership(
  request: Request,
  context: RouteContext<"/api/rooms/[code]/membership">,
) {
  return handleMembership(request, (await context.params).code);
}

export const GET = membership;
export const PUT = membership;
