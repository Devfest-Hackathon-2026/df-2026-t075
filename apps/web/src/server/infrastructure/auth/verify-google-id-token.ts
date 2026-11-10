import "server-only";
import { initializeApp } from "firebase-admin/app";
import { FirebaseAuthError, getAuth } from "firebase-admin/auth";

export async function verifyGoogleIdToken(token: string, projectId: string) {
  const app = initializeApp({ projectId }, "user-auth");
  try {
    const claims = await getAuth(app).verifyIdToken(token);
    if (claims.firebase?.sign_in_provider !== "google.com") return null;
    return {
      uid: claims.uid,
      displayName: typeof claims.name === "string" ? claims.name : null,
    };
  } catch (error) {
    if (
      error instanceof FirebaseAuthError &&
      [
        "auth/argument-error",
        "auth/id-token-expired",
        "auth/invalid-id-token",
      ].includes(error.code)
    ) {
      return null;
    }
    throw error;
  }
}
