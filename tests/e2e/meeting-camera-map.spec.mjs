import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, test } from "@playwright/test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { memberAccess } from "../../apps/web/scripts/live-map/member-access.mjs";
import { memberGateway } from "../../apps/web/scripts/live-map/member-gateway.mjs";
import { signInWithTestGoogle } from "./sign-in";

test.skip(
  process.env.MEETING_CAMERA_LIVE !== "1",
  "Requires a running LiveKit server.",
);
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  trace: "off",
  screenshot: "off",
  video: "off",
});

test("a member reads the fullscreen map without replacing either camera track", async ({
  page: host,
  browser,
  baseURL,
}) => {
  test.setTimeout(80000);
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8180");
  const db = getFirestore(
    initializeApp({ projectId: "demo-meeting-auth" }, "map-camera"),
  );
  const origin = "http://127.0.0.1:3158";
  const relay = memberGateway({
    access: memberAccess(db, origin),
    allowedOrigins: [baseURL],
    services: {
      // This camera test sends a typed proposal; no cloud inference or recording is needed.
      predict: async ([turn]) => ({
        nodes: [
          {
            id: "idea1",
            kind: "idea",
            text: turn.text,
            sourceUtteranceIds: [turn.id],
          },
        ],
        edges: [],
      }),
    },
  });
  const settings = db.doc("roomMapSettings/default");
  const guest = await browser.newPage();
  const enter = async (page) => {
    await page.getByRole("checkbox", { name: /18歳以上/ }).check();
    await page.getByRole("checkbox", { name: /文字に起こす/ }).check();
    await page.getByRole("button", { name: "入室する", exact: true }).click();
    await page.getByRole("button", { name: "カメラをオンにする" }).click();
  };
  try {
    relay.server.listen(3158, "127.0.0.1");
    await once(relay.server, "listening");
    await host.goto("/");
    await signInWithTestGoogle(host, "focus-host@example.test", "会場係");
    await host.getByRole("link", { name: "部屋を開く" }).click();
    await host.getByRole("link", { name: /部屋を作る/ }).click();
    await host.getByLabel("話し合いのお題").fill("読書会の会場");
    await host.getByRole("button", { name: "部屋を作る" }).click();
    const dialog = host.getByRole("dialog", { name: "部屋ができました" });
    const invite = await dialog.getByLabel("招待リンク").inputValue();
    const code = new URL(invite).pathname.split("/").pop();
    const roomId = (await db.doc("roomInvites/" + code).get()).get("roomId");
    await settings.set({
      origin,
      enabled: true,
      roomId,
      session: randomUUID(),
    });
    await dialog.getByRole("link", { name: "部屋に入る" }).click();
    await guest.goto(invite);
    await signInWithTestGoogle(guest, "focus-guest@example.test", "案内係");
    await enter(guest);
    await enter(host);
    const videos = host.locator(".person-tile video");
    await expect
      .poll(() =>
        videos.evaluateAll((vs) => vs.filter((v) => v.videoWidth > 0).length),
      )
      .toBe(2);
    const original = await videos.evaluateAll((vs) =>
      vs.map((v) => v.srcObject.getVideoTracks()[0].id),
    );
    await host.getByRole("button", { name: "議論マップを開く" }).click();
    await host.getByRole("button", { name: "全画面表示" }).click();
    const dock = host.getByRole("region", { name: "参加者の小窓" });
    const remote = dock.getByLabel("案内係のカメラ映像");
    await expect(remote).toBeVisible();
    const frame = () =>
      remote.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames);
    const before = await frame();
    const grip = dock.getByRole("button", { name: "小窓の位置を変える" });
    const rect = await grip.boundingBox();
    await host.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await host.mouse.down();
    await host.mouse.move(80, 110, { steps: 8 });
    await host.mouse.up();
    await expect(dock).toHaveAttribute("data-corner", "top-left");
    await expect.poll(frame).toBeGreaterThan(before);
    await expect(
      guest.getByRole("button", { name: "議論マップを開く" }),
    ).toBeVisible();
    await guest.getByRole("button", { name: "議論マップを開く" }).click();
    await guest.getByText("文字で発言する", { exact: true }).click();
    await guest
      .getByLabel("発言", { exact: true })
      .fill("読書会は図書館で開きたいです。");
    await guest.getByRole("button", { name: "発言を送る" }).click();
    await expect(host.locator("[data-map-node]").first()).toContainText(
      "図書館",
    );
    await host.getByRole("button", { name: "全画面を終了" }).click();
    await expect(
      host.getByRole("button", { name: "全画面表示" }),
    ).toBeFocused();
    expect(
      await videos.evaluateAll((vs) =>
        vs.map((v) => v.srcObject.getVideoTracks()[0].id),
      ),
    ).toEqual(original);
    await expect(
      host.getByRole("button", { name: "マイクをオンにする" }),
    ).toBeEnabled();
  } finally {
    await guest.close();
    await relay.close();
    await settings.delete();
  }
});
