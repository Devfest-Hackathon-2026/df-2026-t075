import "server-only";
import { readAuthConfig } from "@/server/infrastructure/auth/config";
import { verifyGoogleIdToken } from "@/server/infrastructure/auth/verify-google-id-token";
import { ensureUserProfile } from "@/server/infrastructure/firestore/user-profile";
import { createHttpHandler } from "@/server/infrastructure/http/handler";
import { getServerLogger } from "./runtime.server";

export function getSignInConfig() {
  return readAuthConfig(process.env);
}

export function handleCurrentUser(request: Request): Promise<Response> {
  return withGoogleUser(request, async (user, projectId) => {
    if (request.method === "PUT") {
      await ensureUserProfile(projectId, user.uid, user.displayName);
    }
    return Response.json({ uid: user.uid });
  });
}

export function withGoogleUser(
  request: Request,
  handle: (
    user: { uid: string; displayName: string | null },
    projectId: string,
  ) => Promise<Response>,
): Promise<Response> {
  return createHttpHandler(
    async () => {
      const token = /^Bearer ([^\s,]+)$/i.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (token) {
        const config = getSignInConfig();
        if (!config) return new Response(null, { status: 503 });
        const user = await verifyGoogleIdToken(token, config.projectId);
        if (user && !user.uid.includes("/"))
          return handle(user, config.projectId);
      }
      return new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    },
    { logger: getServerLogger() },
  )(request);
}
