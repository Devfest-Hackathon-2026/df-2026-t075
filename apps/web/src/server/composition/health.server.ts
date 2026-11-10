import "server-only";
import { createHttpHandler } from "@/server/infrastructure/http/handler";
import { getServerLogger } from "./runtime.server";

export async function handleHealthRequest(request: Request): Promise<Response> {
  const logger = getServerLogger();
  return createHttpHandler(
    () => Response.json({ status: "ok", kind: "liveness" }),
    { logger },
  )(request);
}
