import type { Logger } from "../logging";
import { resolveRequestId } from "./request-id";

type Handler = (request: Request) => Response | Promise<Response>;

type HandlerDependencies = {
  logger: Logger;
  now?: () => number;
};

/** Shared HTTP boundary: correlate requests and keep exception details private. */
export function createHttpHandler(
  handler: Handler,
  { logger, now = () => performance.now() }: HandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const startedAt = now();
    const requestId = resolveRequestId(request.headers.get("x-request-id"));
    let response: Response;
    let failed = false;

    try {
      response = await handler(request);
    } catch {
      failed = true;
      response = Response.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "The request could not be completed.",
            requestId,
          },
        },
        { status: 500 },
      );
    }

    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    headers.set("cache-control", "no-store");

    logger.log(response.status >= 500 ? "error" : "info", {
      event: "http.request.completed",
      requestId,
      method: safeMethod(request.method),
      statusCode: response.status,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
      ...(failed ? { errorCode: "INTERNAL_ERROR" as const } : {}),
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function safeMethod(method: string): string {
  return ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
    method,
  )
    ? method
    : "OTHER";
}
