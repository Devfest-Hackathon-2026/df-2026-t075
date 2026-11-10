import { handleDatabaseCheck } from "@/server/composition/database-check.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleDatabaseCheck(request);
}
