import "server-only";
import { createHttpHandler } from "@/server/infrastructure/http/handler";
import { issueVoiceProbe } from "@/server/infrastructure/livekit/voice-probe";
import { getServerLogger } from "./runtime.server";

export function handleVoiceProbe(request: Request): Promise<Response> {
  return createHttpHandler((req) => issueVoiceProbe(req, process.env), {
    logger: getServerLogger(),
  })(request);
}
