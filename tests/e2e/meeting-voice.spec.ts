import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { signInWithTestGoogle } from "./sign-in";

// No Playwright artifacts containing live media, captions, or tokens.
const cameraOptions = {
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
};
test.use({
  launchOptions: cameraOptions,
  trace: "off",
  screenshot: "off",
  video: "off",
});
test.skip(
  process.env.MEETING_VOICE_LIVE !== "1",
  "Requires LiveKit and billed Google services.",
);

type AudioKind = "参加者の音声" | "AIの音声";
declare global {
  interface Window {
    callTest: {
      speak: (seconds?: number) => Promise<number>;
      firstHeard: (kind: AudioKind) => number;
      watch: (kind: AudioKind) => Promise<void>;
      heard: (kind: AudioKind) => boolean;
    };
  }
}

async function recordedMicrophone(page: Page, wav: string) {
  // Only the physical microphone is replaced. Both media directions use real WebRTC.
  await page.addInitScript((encoded) => {
    let context: AudioContext;
    let mic: MediaStreamAudioDestinationNode;
    let recording: AudioBuffer;
    const heard = new Map<string, number>();
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.video) return capture(constraints);
      context = new AudioContext();
      await context.resume();
      recording = await context.decodeAudioData(
        Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)).buffer,
      );
      mic = context.createMediaStreamDestination();
      return mic.stream;
    };
    window.callTest = {
      async speak(seconds) {
        const source = context.createBufferSource();
        source.buffer = recording;
        source.connect(mic);
        const done = new Promise<void>((resolve) => {
          source.onended = () => resolve();
        });
        const duration = seconds ?? recording.duration;
        const samples = recording.getChannelData(0);
        let end = Math.min(
          samples.length,
          Math.floor(duration * recording.sampleRate),
        );
        while (end && Math.abs(samples[end - 1]!) < 0.025) end--;
        const lastVoice = Date.now() + (1000 * end) / recording.sampleRate;
        source.start(0, 0, duration);
        await done;
        source.disconnect();
        return lastVoice;
      },
      async watch(kind) {
        heard.delete(kind);
        const element = document.querySelector<HTMLAudioElement>(
          `audio[aria-label="${kind}"]`,
        );
        if (!(element?.srcObject instanceof MediaStream))
          throw new Error("missing remote audio");
        const input = context.createMediaStreamSource(element.srcObject);
        const analyser = context.createAnalyser();
        input.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const timer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          if (samples.some((value) => Math.abs(value) > 0.025)) {
            heard.set(kind, Date.now());
            clearInterval(timer);
            input.disconnect();
          }
        }, 20);
      },
      heard: (kind) => heard.has(kind),
      firstHeard: (kind) => heard.get(kind) ?? 0,
    };
  }, wav);
}

test("two members hear each other and receive the same requested AI reply", async ({
  playwright,
  page,
}) => {
  test.setTimeout(150_000);
  const file = process.env.MEETING_VOICE_WAV;
  if (!file)
    throw new Error(
      "Set MEETING_VOICE_WAV to a short, consented Japanese WAV.",
    );
  const wav = readFileSync(file).toString("base64");
  const background = process.env.MEETING_BACKGROUND_WAV;
  const proposalPhase = process.env.MEETING_TEST_PROPOSAL;
  const automatic = proposalPhase === "automatic";
  const preparing = automatic || proposalPhase === "preparing";
  const proposes = preparing || proposalPhase === "confirmed";
  const firstPart = process.env.MEETING_TEST_FIRST_PART;
  const guestWav = background
    ? readFileSync(background).toString("base64")
    : wav;
  const mapOrigin =
    process.env.MEETING_TEST_RESEARCH === "1" &&
    process.env.MEETING_TEST_MAP_ORIGIN;
  if (mapOrigin)
    expect(process.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8180");
  const mapDb = mapOrigin
    ? getFirestore(
        initializeApp({ projectId: "demo-meeting-auth" }, "voice-map"),
      )
    : undefined;
  const guestBrowser = await playwright.chromium.launch(cameraOptions);
  const guest = await guestBrowser.newPage({
    viewport: { width: 390, height: 844 },
  });
  try {
    await Promise.all([
      recordedMicrophone(page, wav),
      recordedMicrophone(guest, guestWav),
    ]);
    await page.goto("/");
    await signInWithTestGoogle(page, "voice-host@example.test", "通話主催者");
    await page.getByRole("link", { name: "部屋を開く" }).click();
    await page.getByRole("link", { name: /部屋を作る/ }).click();
    await page.getByLabel("話し合いのお題").fill("音声通話の確認");
    await page.getByRole("button", { name: "部屋を作る" }).click();
    const dialog = page.getByRole("dialog", { name: "部屋ができました" });
    const url = await dialog.getByLabel("招待リンク").inputValue();
    const details = page.waitForResponse(
      (r) => r.url().endsWith("/membership") && r.request().method() === "GET",
    );
    await dialog.getByRole("link", { name: "部屋に入る" }).click();
    const { roomId } = await (await details).json();
    if (mapDb) {
      await mapDb.doc("roomMapSettings/default").set({
        origin: mapOrigin,
        enabled: true,
        roomId,
        session: randomUUID(),
      });
      await page.reload();
    }
    await guest.goto(url);
    const login = guest.waitForRequest(
      (r) => r.url().endsWith("/api/auth/me") && r.method() === "PUT",
    );
    await signInWithTestGoogle(guest, "voice-guest@example.test", "通話参加者");
    const bearer = await (await login).headerValue("authorization");
    const admission = (id: string, signedIn: boolean) =>
      guest.evaluate(
        async ({ id, auth }) =>
          (
            await fetch("/api/meetings/" + id + "/voice", {
              method: "POST",
              headers: auth ? { authorization: auth } : {},
            })
          ).status,
        { id, auth: signedIn ? bearer : null },
      );
    expect(await admission(roomId, false)).toBe(401);
    expect(await admission(roomId, true)).toBe(403);
    for (const client of [page, guest]) {
      await client.getByRole("checkbox", { name: /18歳以上/ }).check();
      await client.getByRole("checkbox", { name: /文字に起こす/ }).check();
      await client
        .getByRole("button", { name: "入室する", exact: true })
        .click();
      await client
        .getByRole("button", { name: "マイクをオンにする" })
        .click({ timeout: 25_000 });
      await expect(
        client.getByRole("button", { name: "マイクをオフにする" }),
      ).toBeVisible({ timeout: 25000 });
    }
    if (proposes) {
      await page.getByRole("button", { name: "話し合いを始める" }).click();
      if (!preparing) {
        await page.getByRole("button", { name: "この進め方で始める" }).click();
        await expect(
          page.getByRole("button", { name: "予定を編集する" }),
        ).toBeVisible();
      }
    } else if (firstPart) {
      const agenda = page.getByRole("complementary", { name: "進行メモ" });
      await agenda.getByRole("button", { name: "話し合いを始める" }).click();
      await agenda
        .getByRole("textbox", { name: "パート1の名前" })
        .fill(firstPart);
      const saved = page.waitForResponse(
        (r) =>
          r.url().endsWith("/agenda/v2") && r.request().method() === "POST",
      );
      await agenda.getByRole("button", { name: "案を共有する" }).click();
      expect((await saved).status()).toBe(200);
    }
    expect(await admission("891d7632-0557-4e22-a36f-eace28cade10", true)).toBe(
      403,
    );
    for (const client of [page, guest]) {
      await expect(
        client.getByRole("button", { name: "AIに話す" }),
      ).toBeEnabled({ timeout: 30000 });
      for (const kind of ["参加者の音声", "AIの音声"] as const) {
        await expect(client.locator(`audio[aria-label="${kind}"]`)).toHaveCount(
          1,
        );
        await client.evaluate((k) => window.callTest.watch(k), kind);
      }
    }
    if (process.env.MEETING_TEST_RESEARCH === "1") {
      const map = guest.getByRole("region", { name: "ライブ議論マップ" });
      if (mapDb) {
        await page.getByRole("button", { name: "カメラをオンにする" }).click();
        await expect(guest.getByLabel("通話主催者のカメラ映像")).toBeVisible();
        await guest.getByRole("button", { name: "議論マップを開く" }).click();
        await map.getByRole("button", { name: "全画面表示" }).click();
        await expect(
          guest.getByRole("region", { name: "参加者の小窓" }).locator("video"),
        ).toBeVisible();
      }
      const requester = mapDb ? guest : page;
      const controls = mapDb ? map : page;
      await controls.getByRole("button", { name: "AIに話す" }).click();
      await expect(
        controls.getByRole("button", { name: "話し終えた" }),
      ).toBeEnabled();
      await requester.evaluate(() => window.callTest.speak());
      if (mapDb) {
        await expect(map.getByText("調査結果が届きました")).toBeVisible({
          timeout: 55_000,
        });
        await map.getByRole("button", { name: "参考資料を開く" }).click();
        await expect(
          map.getByRole("region", { name: "参考資料" }),
        ).toBeVisible();
        await expect(
          map.getByRole("region", { name: "議論のつながり" }),
        ).toBeVisible({ timeout: 30_000 });
      }
      for (const tab of [page, guest]) {
        const section = tab.getByRole("region", { name: "参考資料" });
        await expect(section.getByRole("link")).toHaveAttribute(
          "href",
          "https://www.f-cp.jp/shimin/guide/guide05/#c01",
          { timeout: 55_000 },
        );
        await expect(section).toContainText("9〜22時");
        if (!mapDb || tab === page)
          await expect(tab.getByRole("img", { name: "挙手中" })).toBeVisible();
        expect(
          await tab.evaluate(() => window.callTest.heard("AIの音声")),
        ).toBe(false);
      }
      const references = page.getByRole("region", { name: "参考資料" });
      expect(
        await guest.getByRole("region", { name: "参考資料" }).innerText(),
      ).toEqual(await references.innerText());
      const original = await guestBrowser.newPage();
      const link = await references.getByRole("link").getAttribute("href");
      await original.goto(link!);
      const originalTable = original
        .locator("#c01 ~ h5")
        .filter({ hasText: "土日休" })
        .first()
        .locator("+ div table");
      const originalFee = await originalTable
        .getByRole("row")
        .filter({ hasText: "9〜22時" })
        .getByRole("cell")
        .nth(1)
        .innerText();
      await expect(references).toContainText(originalFee + "円");
      await original.close();
      await (mapDb ? map : guest)
        .getByRole("button", { name: "どうぞ（調査結果）" })
        .click();
      for (const tab of [page, guest]) {
        await expect
          .poll(() => tab.evaluate(() => window.callTest.heard("AIの音声")), {
            timeout: 35_000,
          })
          .toBe(true);
        await expect(tab.locator(".meeting-transcript")).toContainText(
          originalFee,
        );
      }
      if (mapDb) {
        await expect(map.getByText("調査結果が届きました")).toHaveCount(0);
        await expect(
          map.getByRole("region", { name: "参考資料" }),
        ).toContainText(originalFee);
        await expect(
          page
            .locator(".meeting-stage")
            .getByRole("region", { name: "参考資料" }),
        ).toBeVisible();
        await map.getByRole("button", { name: "全画面を終了" }).click();
        await guest.getByRole("button", { name: "退室する" }).click();
        await expect(
          guest.getByRole("heading", { name: "退室しました" }),
        ).toBeVisible();
        const ticket = await guest.request.post(
          "/api/meetings/" + roomId + "/map",
          {
            headers: { authorization: bearer! },
          },
        );
        expect(ticket.status()).toBe(403);
        // Close the emulator room after the guest has left.
        await mapDb.doc("rooms/" + roomId).update({ status: "closed" });
        await guest.reload();
        await guest.getByRole("link", { name: "話し合いのノート" }).click();
        const archived = guest.getByRole("region", { name: "参考資料" });
        await expect(archived).toContainText(originalFee + "円");
        await expect(archived.getByRole("link")).toHaveAttribute("href", link!);
      }
      return;
    }
    if (automatic) {
      const minutes = page.getByLabel("パート2の時間（分）");
      await minutes.fill("8");
      await page.evaluate(() => window.callTest.speak());
      for (const tab of [page, guest]) {
        await expect(
          tab.getByRole("region", { name: "AIによる予定変更" }),
        ).toContainText("会場", { timeout: 45_000 });
        await expect(
          tab.getByRole("heading", { name: "AIの提案で反映した変更" }),
        ).toBeVisible();
        await expect(
          tab.getByRole("button", { name: "この変更を反映する" }),
        ).toHaveCount(0);
      }
      await expect(guest.getByLabel("パート1の名前")).toHaveValue(/会場/);
      await expect(minutes).toHaveValue("8");
      await guest.getByRole("button", { name: "この進め方で始める" }).click();
      await expect(guest.getByLabel("共有メモを書き足す")).toBeVisible();
      await guest.evaluate(() => window.callTest.speak());
      const manual = "候補の空き状況を確認する";
      await guest.getByLabel("共有メモを書き足す").fill(manual);
      await guest.getByRole("button", { name: "追記する" }).click();
      for (const tab of [page, guest]) {
        const items = tab.locator(".part-row.current li");
        await expect(
          items.filter({ hasText: /(?:3万|三万|30[,，]?000)円/ }),
        ).toHaveCount(1, { timeout: 45_000 });
        await expect(items.filter({ hasText: manual })).toHaveCount(1);
        expect(
          await tab.evaluate(() => window.callTest.heard("AIの音声")),
        ).toBe(false);
        await expect(tab.locator(".meeting-transcript p")).toHaveCount(0);
      }
      return;
    }
    await Promise.all([
      page.evaluate(() => window.callTest.speak(0.8)),
      guest.evaluate(() => window.callTest.speak()),
    ]);
    for (const client of [page, guest]) {
      await expect
        .poll(() =>
          client.evaluate(() => window.callTest.heard("参加者の音声")),
        )
        .toBe(true);
      expect(
        await client.evaluate(() => window.callTest.heard("AIの音声")),
      ).toBe(false);
      await expect(client.locator(".meeting-transcript p")).toHaveCount(0);
    }
    for (let round = 0; round < (background && !proposes ? 2 : 1); round++) {
      if (round) {
        await expect(
          page.getByRole("button", { name: "AIに話す" }),
        ).toBeEnabled({ timeout: 30000 });
        for (const client of [page, guest])
          await client.evaluate(() => window.callTest.watch("AIの音声"));
      }
      const earlyAudio =
        round === 1 ? page.evaluate(() => window.callTest.speak()) : null;
      if (earlyAudio) await new Promise((resolve) => setTimeout(resolve, 240));
      await page.getByRole("button", { name: "AIに話す" }).click();
      const finish = page.getByRole("button", { name: "話し終えた" });
      await expect(finish).toBeEnabled();
      await expect(
        guest.getByRole("button", { name: "AIに話す" }),
      ).toBeDisabled();
      const lastVoice = await (earlyAudio ??
        page.evaluate(() => window.callTest.speak()));
      if (!background) await finish.click();
      const replies = [];
      for (const client of [page, guest]) {
        await expect
          .poll(
            () => client.evaluate(() => window.callTest.heard("AIの音声")),
            {
              timeout: 75000,
            },
          )
          .toBe(true);
        await expect(client.locator(".meeting-transcript p")).toHaveCount(2, {
          timeout: 75000,
        });
        replies.push(
          await client.locator(".meeting-transcript p").last().textContent(),
        );
        if (process.env.MEETING_QUESTION_PREFIX)
          expect(
            (
              await client
                .locator(".meeting-transcript p")
                .first()
                .textContent()
            )?.includes(process.env.MEETING_QUESTION_PREFIX),
          ).toBe(true);
      }
      expect(Boolean(replies[0]) && replies[0] === replies[1]).toBe(true);
      if (firstPart)
        expect(Boolean(replies[0]?.includes(firstPart))).toBe(true);
      if (proposes) {
        expect(replies[0]).toContain(
          preparing
            ? "進行案を更新しました。"
            : "変更案を出しました。画面で確認してください。",
        );
        for (const tab of [page, guest]) {
          const proposal = tab.getByRole("region", {
            name: "AIによる予定変更",
          });
          await expect(proposal).toContainText(/(?:3万|三万|30[,，]?000)円/);
          await expect(proposal).toContainText(/追加（5分）/);
          await expect(proposal).toContainText("15分 → 10分");
        }
        if (preparing) {
          for (const tab of [page, guest]) {
            await expect(
              tab.getByRole("heading", { name: "AIの提案で反映した変更" }),
            ).toBeVisible({ timeout: 15_000 });
            await expect(
              tab.getByRole("button", { name: "この変更を反映する" }),
            ).toHaveCount(0);
            const names = await tab
              .getByRole("textbox", { name: /パート[0-9]+の名前/ })
              .evaluateAll((inputs) =>
                inputs.map((el) => (el as HTMLInputElement).value),
              );
            const index = names.indexOf("アイデアを深める");
            expect(index).toBeGreaterThanOrEqual(0);
            await expect(
              tab.getByLabel(`パート${index + 1}の時間（分）`),
            ).toHaveValue("10");
          }
        } else {
          await guest
            .getByLabel("共有メモを書き足す")
            .fill("会場費の条件を確認しました");
          await guest.getByRole("button", { name: "追記する" }).click();
          await expect(
            page.getByText("会場費の条件を確認しました", { exact: true }),
          ).toBeVisible({ timeout: 15_000 });
          await page
            .getByRole("button", { name: "この変更を反映する" })
            .click();
          for (const tab of [page, guest]) {
            await expect(
              tab.getByRole("heading", { name: "AIの提案で反映した変更" }),
            ).toBeVisible({ timeout: 15_000 });
            await expect(
              tab.locator("summary").filter({ hasText: "アイデアを深める" }),
            ).toContainText("10分");
            await expect(
              tab.getByText("会場費の条件を確認しました", { exact: true }),
            ).toBeVisible();
          }
        }
      } else if (background)
        expect(
          /(?:3万|三万|30[,，]?000)円/.test(
            replies[0]?.normalize("NFKC") ?? "",
          ),
        ).toBe(true);
      const firstVoice = await guest.evaluate(() =>
        window.callTest.firstHeard("AIの音声"),
      );
      console.log(
        "AI audio latency (ms)",
        round + 1,
        Math.round(firstVoice - lastVoice),
      );
    }
    await guest.getByRole("button", { name: "退室する" }).click();
    await expect(
      guest.getByRole("heading", { name: "退室しました" }),
    ).toBeVisible();
    expect(await admission(roomId, true)).toBe(403);
    await expect(page.locator("audio[aria-label='参加者の音声']")).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "AIに話す" })).toBeEnabled({
      timeout: 30000,
    });
  } finally {
    await guestBrowser.close();
    if (mapDb) await mapDb.doc("roomMapSettings/default").delete();
  }
});
