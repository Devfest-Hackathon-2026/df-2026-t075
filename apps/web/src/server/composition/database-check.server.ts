import "server-only";
import { createHttpHandler } from "@/server/infrastructure/http/handler";
import { isOperator } from "@/server/infrastructure/http/operator";
import { verifyFirestoreEvent } from "@/server/infrastructure/firestore/connection-check";
import { verifyDatabaseConnection } from "@/server/infrastructure/sql-connect/connection-check";
import { getServerLogger } from "./runtime.server";

export function handleDatabaseCheck(request: Request): Promise<Response> {
  return runOperatorCheck(
    request,
    verifyDatabaseConnection,
    "database-roundtrip",
  );
}

export function handleFunctionCheck(request: Request): Promise<Response> {
  return runOperatorCheck(
    request,
    verifyFirestoreEvent,
    "firestore-event-roundtrip",
  );
}

function runOperatorCheck(
  request: Request,
  check: () => Promise<void>,
  kind: string,
): Promise<Response> {
  return createHttpHandler(
    async () => {
      if (!isOperator(request, process.env.DB_CHECK_TOKEN)) {
        return new Response(null, { status: 404 });
      }

      await check();
      return Response.json({ status: "ok", kind });
    },
    { logger: getServerLogger() },
  )(request);
}
