import "server-only";
import { OAuth2Client } from "google-auth-library";

const verifier = new OAuth2Client();

export async function verifyWorker(
  token: string,
  audience: string,
  email: string,
) {
  if (!/@[a-z0-9.-]+\.gserviceaccount\.com$/.test(email)) return false;
  try {
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const claims = ticket.getPayload();
    return (
      claims?.email_verified === true &&
      claims.email === email &&
      (claims.iss === "accounts.google.com" ||
        claims.iss === "https://accounts.google.com")
    );
  } catch {
    return false;
  }
}
