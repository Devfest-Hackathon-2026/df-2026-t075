import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { liveServices } from "./live-map/cloud.mjs";
import { memberAccess } from "./live-map/member-access.mjs";
import { memberGateway } from "./live-map/member-gateway.mjs";

try {
  const { GOOGLE_CLOUD_PROJECT: project, MEETING_MAP_ORIGIN: origin } =
    process.env;
  if (
    process.env.MEETING_VOICE_ENABLED !== "1" ||
    !origin ||
    new URL(origin).origin !== origin
  )
    throw new Error("configuration");
  const db = getFirestore(initializeApp({ projectId: project }));
  const allowedOrigins = [
    `https://${project}.web.app`,
    `https://${project}.firebaseapp.com`,
  ];
  if (process.env.FIRESTORE_EMULATOR_HOST && process.env.MEETING_MAP_WEB_ORIGIN)
    allowedOrigins.push(process.env.MEETING_MAP_WEB_ORIGIN);
  const relay = memberGateway({
    services: await liveServices(process.env.MEETING_MAP_AI_PROJECT || project),
    access: memberAccess(db, origin),
    allowedOrigins,
  });
  relay.server.listen(
    Number(process.env.PORT || 8080),
    process.env.FIRESTORE_EMULATOR_HOST ? "127.0.0.1" : "0.0.0.0",
  );
  const stop = () => void relay.close().finally(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch {
  console.error("議論マップの接続設定を確認してください。");
  process.exitCode = 1;
}
