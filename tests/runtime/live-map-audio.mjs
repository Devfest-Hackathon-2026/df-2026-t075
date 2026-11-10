// Real Google services, two independent browser microphone inputs, no transcripts
// or invitation keys written to disk. Run only against an otherwise empty demo.
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const [hostWav, guestWav, hostUrl = "http://127.0.0.1:3117/demo/map/live"] =
  process.argv.slice(2);
let stage = "arguments";
const browsers = [];
async function client(wav) {
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${resolve(wav)}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  browsers.push(browser);
  const page = await browser.newPage({ permissions: ["microphone"] });
  page.setDefaultTimeout(18_000);
  await page.addInitScript(() => {
    window.__remoteFrames = 0;
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      // Count audible frames actually scheduled for playout, not just packets received.
      if (
        this.buffer &&
        this.context.state === "running" &&
        this.buffer.getChannelData(0).some((x) => Math.abs(x) > 0.008)
      )
        window.__remoteFrames++;
      return original.apply(this, args);
    };
  });
  return page;
}
async function join(page, url, name, button) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByLabel("表示名").fill(name);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("heading", { name: "参加者", exact: true }).waitFor();
}
async function voice(from, to, count) {
  const heardBefore = await to.evaluate(() => window.__remoteFrames);
  await from.getByRole("button", { name: "マイクをオン", exact: true }).click();
  await to.waitForFunction((b) => window.__remoteFrames >= b + 5, heardBefore, {
    timeout: 20_000,
  });
  await from.waitForFunction(
    (n) =>
      document
        .querySelector(".live-captions summary")
        ?.textContent.includes(`（${n}件）`),
    count,
    { timeout: 35_000 },
  );
  await from.getByRole("button", { name: "マイクをオフ", exact: true }).click();
}
let host;
try {
  await Promise.all([access(hostWav), access(guestWav)]);
  stage = "create";
  host = await client(hostWav);
  const guest = await client(guestWav);
  await join(host, hostUrl, "デモ甲", "デモの部屋を作る");
  stage = "invite";
  await host.getByText("メンバーを招待", { exact: true }).click();
  const invite = await host
    .getByLabel("招待リンク", { exact: true })
    .inputValue();
  await join(guest, invite, "デモ乙", "入室する");
  stage = "first voice received and transcribed";
  await voice(host, guest, 1);
  stage = "second voice received and transcribed";
  await voice(guest, host, 2);
  stage = "real shared maps";
  for (const page of [host, guest]) {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".live-captions li small").length === 2 &&
        [...document.querySelectorAll(".live-captions li small")].every(
          (el) => el.textContent === "反映済み",
        ),
      null,
      { timeout: 150_000 },
    );
  }
  const cards = (p) => p.locator("[data-map-node]").allTextContents();
  const actual = await cards(host);
  assert.ok(actual.length > 0);
  assert.deepEqual(await cards(guest), actual);
  const captions = (p) => p.locator(".live-captions li").allTextContents();
  const turns = await captions(guest);
  assert.deepEqual(await captions(host), turns);
  assert.match(turns[0], /デモ甲.*図書館/);
  assert.match(turns[1], /デモ乙.*予約/);
  await guest.locator("[data-map-node]").first().click();
  assert.ok((await guest.locator(".map-quotes li").count()) > 0);
  stage = "end room";
  await host.getByRole("button", { name: "部屋を終了", exact: true }).click();
  await host.getByRole("button", { name: "終了して消去", exact: true }).click();
  await guest
    .getByText("部屋が終了しました。発言とマップを消去しました。")
    .waitFor();
  console.log(
    JSON.stringify({
      speakers: 2,
      transcribed: 2,
      sharedCards: actual.length,
      bidirectionalAudible: true,
      closed: true,
    }),
  );
} catch {
  console.error("実音声経路を確認できませんでした。段階: " + stage);
  process.exitCode = 1;
} finally {
  if (host)
    try {
      if (
        await host
          .getByRole("button", { name: "部屋を終了", exact: true })
          .count()
      ) {
        await host
          .getByRole("button", { name: "部屋を終了", exact: true })
          .click();
        await host
          .getByRole("button", { name: "終了して消去", exact: true })
          .click();
      }
    } catch {
      /* Shutdown also expires an empty demo room. */
    }
  await Promise.all(browsers.map((b) => b.close()));
}
