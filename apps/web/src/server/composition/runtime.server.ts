import "server-only";
import { readServerEnvironment } from "@/server/infrastructure/environment";
import { createJsonLogger } from "@/server/infrastructure/logging";
import type { Logger } from "@/server/infrastructure/logging";

let logger: Logger | undefined;

/** Called only by the Next.js Node instrumentation startup hook. */
export function initializeServerRuntime(): void {
  getServerLogger().log("info", { event: "runtime.started" });
}

/** Bundle-local cache: safe to create separately in instrumentation and routes. */
export function getServerLogger(): Logger {
  if (logger === undefined) {
    const environment = readServerEnvironment(process.env);
    logger = createJsonLogger(environment.logLevel);
  }
  return logger;
}
