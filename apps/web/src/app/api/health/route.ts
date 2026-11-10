import { handleHealthRequest } from "@/server/composition/health.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleHealthRequest(request);
}
