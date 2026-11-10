/** Only these Firebase Web settings may be serialized into the page. */
export function readAuthConfig(
  env: Readonly<Record<string, string | undefined>>,
) {
  const projectId = env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) return null;

  const emulatorHost = env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulatorHost) {
    // Emulated identities must only create profiles in a local Firestore emulator.
    const loopback = /^(127\.0\.0\.1|localhost):\d{1,5}$/;
    if (
      !projectId.startsWith("demo-") ||
      !loopback.test(emulatorHost) ||
      !loopback.test(env.FIRESTORE_EMULATOR_HOST ?? "")
    ) {
      return null;
    }
    return {
      projectId,
      apiKey: "demo-api-key",
      authDomain: `${projectId}.firebaseapp.com`,
      appId: "demo-web-app",
      emulatorUrl:
        env.FIREBASE_AUTH_EMULATOR_SAME_ORIGIN === "1"
          ? "/"
          : `http://${emulatorHost}`,
    };
  }

  const apiKey = env.FIREBASE_WEB_API_KEY;
  const authDomain = env.FIREBASE_AUTH_DOMAIN;
  const appId = env.FIREBASE_WEB_APP_ID;
  if (!apiKey || !authDomain || !appId) return null;
  return { projectId, apiKey, authDomain, appId, emulatorUrl: null };
}
