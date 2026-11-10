import { handleVoiceProbe } from "@/server/composition/voice-probe.server";

export const runtime = "nodejs";
export const POST = handleVoiceProbe;
