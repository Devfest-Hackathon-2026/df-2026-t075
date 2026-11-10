import type { LogLevel } from "./environment";

export type LogEvent = Readonly<{
  event: "runtime.started" | "http.request.completed";
  requestId?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  errorCode?: "INTERNAL_ERROR";
}>;

export type Logger = {
  log: (level: LogLevel, event: LogEvent) => void;
};

const severity: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/** An allowlist prevents accidental logging of headers, bodies, or Error objects. */
export function createJsonLogger(
  minimumLevel: LogLevel,
  writeLine: (line: string) => void = (line) => console.log(line),
  now: () => Date = () => new Date(),
): Logger {
  return {
    log(level, event) {
      if (severity[level] < severity[minimumLevel]) return;

      writeLine(
        JSON.stringify({
          timestamp: now().toISOString(),
          severity: level.toUpperCase(),
          service: "ai-classroom-web",
          event: event.event,
          requestId: event.requestId,
          method: event.method,
          statusCode: event.statusCode,
          durationMs: event.durationMs,
          errorCode: event.errorCode,
        }),
      );
    },
  };
}
