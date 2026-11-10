import { expect, test, type Locator, type Page } from "@playwright/test";
import { signInWithTestGoogle } from "./sign-in";

const launchOptions = {
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
};
test.use({ launchOptions, trace: "off", screenshot: "off", video: "off" });
test.skip(
  process.env.MEETING_CAMERA_LIVE !== "1",
  "Requires a running LiveKit server.",
);

async function expectVideoPlaying(video: Locator) {
  await expect(video).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      () =>
        video.evaluate(
          (node: HTMLVideoElement) =>
            node.videoWidth > 0 &&
            !node.paused &&
            node.getVideoPlaybackQuality().totalVideoFrames > 1,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

function captureTrack(video: Locator) {
  return video.evaluateHandle(
    (node: HTMLVideoElement) =>
      (node.srcObject as MediaStream).getVideoTracks()[0],
  );
}

async function joinCall(page: Page) {
  await page.getByRole("checkbox", { name: /18歳以上/ }).check();
  await page.getByRole("checkbox", { name: /文字に起こす/ }).check();
  await page.getByRole("button", { name: "入室する", exact: true }).click();
  await page
    .getByRole("button", { name: "マイクをオンにする" })
    .click({ timeout: 25_000 });
  await expect(
    page.getByRole("button", { name: "マイクをオフにする" }),
  ).toBeVisible({ timeout: 25_000 });
  await expect(
    page.getByRole("button", { name: "カメラをオンにする" }),
  ).toBeEnabled();
  await expect(page.getByLabel("自分のカメラ映像")).toHaveCount(0);
}

test("members preview privately and send camera frames in both directions until mute or leave", async ({
  playwright,
  page: host,
}) => {
  test.setTimeout(120_000);
  const browser = await playwright.chromium.launch(launchOptions);
  const guest = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  try {
    await host.goto("/");
    await signInWithTestGoogle(host, "camera-host@example.test", "映像主催者");
    await host.getByRole("link", { name: "部屋を開く" }).click();
    await host.getByRole("link", { name: /部屋を作る/ }).click();
    await host.getByLabel("話し合いのお題").fill("カメラ共有の確認");
    await host.getByRole("button", { name: "部屋を作る" }).click();
    const dialog = host.getByRole("dialog", { name: "部屋ができました" });
    const invite = await dialog.getByLabel("招待リンク").inputValue();
    await dialog.getByRole("link", { name: "部屋に入る" }).click();
    await guest.goto(invite);
    await signInWithTestGoogle(
      guest,
      "camera-guest@example.test",
      "映像参加者",
    );

    // Keep one member in the call while the other's preview is open.
    await joinCall(guest);
    await host.getByRole("button", { name: "カメラを確認" }).click();
    const selfVideo = host.getByLabel("自分のカメラ映像");
    await expectVideoPlaying(selfVideo);
    const preview = await captureTrack(selfVideo);
    await expect(guest.locator("video")).toHaveCount(0);
    await joinCall(host);
    await expect
      .poll(() => preview.evaluate((track) => track.readyState))
      .toBe("ended");
    await expect(guest.getByLabel("映像主催者のカメラ映像")).toHaveCount(0);

    await host.getByRole("button", { name: "カメラをオンにする" }).click();
    await expectVideoPlaying(selfVideo);
    const published = await captureTrack(selfVideo);
    await expectVideoPlaying(guest.getByLabel("映像主催者のカメラ映像"));
    await host.getByRole("button", { name: "カメラをオフにする" }).click();
    await expect
      .poll(() => published.evaluate((track) => track.readyState))
      .toBe("ended");
    await expect(guest.locator("video")).toHaveCount(0);
    await expect(selfVideo).toHaveCount(0);

    // A camera permission failure must leave the microphone and call usable.
    await guest.evaluate(() => {
      const devices = navigator.mediaDevices;
      const capture = devices.getUserMedia.bind(devices);
      devices.getUserMedia = (constraints) => {
        if (constraints?.video) {
          devices.getUserMedia = capture;
          return Promise.reject(new DOMException("Denied", "NotAllowedError"));
        }
        return capture(constraints);
      };
    });
    const enable = guest.getByRole("button", { name: "カメラをオンにする" });
    await enable.click();
    const cameraError = guest
      .getByRole("alert")
      .filter({ hasText: "カメラを切り替えられません" });
    await expect(cameraError).toBeVisible();
    await expect(
      guest.getByRole("button", { name: "マイクをオフにする" }),
    ).toBeEnabled();
    await enable.click();
    await expectVideoPlaying(host.getByLabel("映像参加者のカメラ映像"));
    await expect(cameraError).toHaveCount(0);
    await host.getByRole("button", { name: "カメラをオンにする" }).click();
    await expectVideoPlaying(guest.getByLabel("映像主催者のカメラ映像"));
    const republished = await captureTrack(selfVideo);
    await host.getByRole("button", { name: "通話を切る" }).click();
    await expect
      .poll(() => republished.evaluate((track) => track.readyState))
      .toBe("ended");
    await expect(guest.getByLabel("映像主催者のカメラ映像")).toHaveCount(0);
    await host.getByRole("button", { name: "通話に再接続" }).click();
    await expectVideoPlaying(host.getByLabel("映像参加者のカメラ映像"));
    await expect(selfVideo).toHaveCount(0);
    const guestCamera = await captureTrack(
      guest.getByLabel("自分のカメラ映像"),
    );
    // Hold the leave request so the server cannot be the one stopping the camera.
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await guest.route("**/membership", async (route) => {
      if (route.request().method() === "PUT") await hold;
      await route.continue();
    });
    try {
      await guest.getByRole("button", { name: "退室する" }).click();
      await expect(
        guest.getByRole("heading", { name: "退室処理中" }),
      ).toBeVisible();
      await expect
        .poll(() => guestCamera.evaluate((track) => track.readyState))
        .toBe("ended");
      await expect(
        guest.getByRole("button", { name: "通話に再接続" }),
      ).toHaveCount(0);
    } finally {
      release();
    }
    await expect(
      guest.getByRole("heading", { name: "退室しました" }),
    ).toBeVisible();
    await expect
      .poll(() => guestCamera.evaluate((track) => track.readyState))
      .toBe("ended");
    await expect(host.locator("video")).toHaveCount(0);
    await expect(
      host.getByRole("button", { name: "マイクをオンにする" }),
    ).toBeEnabled();
  } finally {
    await browser.close();
  }
});
