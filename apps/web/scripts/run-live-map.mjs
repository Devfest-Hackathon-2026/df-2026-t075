import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { liveServices } from "./live-map/cloud.mjs";
import { gateway } from "./live-map/gateway.mjs";
import { shareGuestPort } from "./live-map/tunnel.mjs";

try {
  const appRoot = fileURLToPath(new URL("../", import.meta.url));
  await access(appRoot + "/.next/server/app/demo/map/live.html");
  const app = gateway({
    services: await liveServices(process.env.GOOGLE_CLOUD_PROJECT),
    appRoot,
    hostPort: Number(process.env.LIVE_MAP_HOST_PORT ?? 3117),
    guestPort: Number(process.env.LIVE_MAP_GUEST_PORT ?? 3118),
    guestOrigin: process.env.LIVE_MAP_GUEST_ORIGIN,
    share: process.argv.includes("--share") ? shareGuestPort : null,
  });
  await app.start();
  const stop = () => {
    void app.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log("ライブマップのデモを開始しました。");
} catch {
  console.error(
    "起動できません。Webのビルド、ポート、Google Cloudプロジェクトと招待先の設定を確認してください。",
  );
  process.exitCode = 1;
}
