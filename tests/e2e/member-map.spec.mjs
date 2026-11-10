import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium, expect, test } from "@playwright/test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { WebSocket } from "ws";
import { signInWithTestGoogle } from "./sign-in";
import { liveServices } from "../../apps/web/scripts/live-map/cloud.mjs";
import { memberAccess } from "../../apps/web/scripts/live-map/member-access.mjs";
import { memberGateway } from "../../apps/web/scripts/live-map/member-gateway.mjs";

const web = "http://127.0.0.1:3100";
const real = process.env.MEETING_MAP_LIVE_AI === "1";
const realResearch = process.env.MEETING_RESEARCH_LIVE === "1";
test.use({ trace: "off", screenshot: "off" });
// These cases configure the same emulator-only member gateway.
test.describe.configure({ mode: "default" });

async function createRoom(page, topic) {
  await page.getByRole("link", { name: "部屋を開く" }).click();
  await page.getByRole("link", { name: /部屋を作る/ }).click();
  await page.getByLabel("話し合いのお題").fill(topic);
  await page.getByRole("button", { name: "部屋を作る" }).click();
  const dialog = page.getByRole("dialog", { name: "部屋ができました" });
  const url = await dialog.getByLabel("招待リンク").inputValue();
  await dialog.getByRole("link", { name: "部屋に入る" }).click();
  return url;
}
async function join(page) {
  await page.getByRole("checkbox", { name: /18歳以上/ }).check();
  await page.getByRole("checkbox", { name: /文字に起こす/ }).check();
  await page.getByRole("button", { name: "入室する", exact: true }).click();
}

test("admitted Google users share their room's map while a second room meets independently", async () => {
  test.setTimeout(real ? 155000 : 60000);
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8180");
  const db = getFirestore(
    initializeApp({ projectId: "demo-meeting-auth" }, "member-map-test"),
  );
  const browsers = [];
  const settings = db.doc("roomMapSettings/default");
  let relay;
  const measurements = new Map();
  async function client(wav) {
    const browser = await chromium.launch({
      args: real
        ? [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
            "--use-file-for-fake-audio-capture=" + wav + "%noloop",
          ]
        : ["--autoplay-policy=no-user-gesture-required"],
    });
    browsers.push(browser);
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const observed = { tickets: 0, turns: 0 };
    measurements.set(page, observed);
    page.on("request", (r) => {
      if (r.url().endsWith("/map") && r.method() === "POST") observed.tickets++;
    });
    page.on("websocket", (ws) =>
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        const m = JSON.parse(payload);
        if (m.type === "state") observed.turns = m.turns.length;
      }),
    );
    await page.addInitScript((synthetic) => {
      window.micRequests = 0;
      window.audible = 0;
      const devices = navigator.mediaDevices;
      const capture = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async (constraints) => {
        if (constraints?.audio) window.micRequests++;
        if (synthetic && constraints?.audio) {
          // CI has no physical mic or cloud credentials. Send an audible pulse over the actual call.
          const ctx = new AudioContext();
          await ctx.resume();
          const stream = ctx.createMediaStreamDestination();
          const tone = ctx.createOscillator();
          tone.connect(stream);
          tone.start(ctx.currentTime + 0.5);
          tone.stop(ctx.currentTime + 1.5);
          tone.onended = () => {
            tone.disconnect();
          };
          return stream.stream;
        }
        return capture(constraints);
      };
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        if (
          this.buffer?.getChannelData(0).some((x) => Math.abs(x) > 0.008) &&
          this.context.state === "running"
        )
          window.audible++;
        return start.apply(this, args);
      };
    }, !real);
    return page;
  }
  async function openMap(page) {
    await page.getByRole("button", { name: "議論マップを開く" }).click();
    await expect(
      page.getByRole("region", { name: "会話の字幕" }),
    ).toBeVisible();
    await expect(
      page.locator("#member-map").getByRole("button", { name: /マイク/ }),
    ).toHaveCount(0);
  }
  function callMic(page) {
    return page
      .getByRole("region", { name: "あなたとAIメンバー" })
      .getByRole("button", { name: "マイクをオン", exact: true });
  }
  async function voice(from, to, n) {
    const before = await to.evaluate(() => window.audible);
    await callMic(from).click();
    await expect
      .poll(() => to.evaluate(() => window.audible), { timeout: 18000 })
      .toBeGreaterThan(before + 2);
    // Change the view mid-utterance. The same microphone and connection must keep running.
    await openMap(from);
    await from.getByRole("button", { name: "議論マップを閉じる" }).click();
    await expect
      .poll(() => measurements.get(from).turns, { timeout: 35000 })
      .toBe(n);
    await from
      .getByRole("button", { name: "マイクをオフ", exact: true })
      .click();
  }
  try {
    const host = await client(process.env.MEETING_MAP_HOST_WAV);
    const guest = await client(process.env.MEETING_MAP_GUEST_WAV);
    await host.goto(web);
    await signInWithTestGoogle(host, "map-host@example.test", "マップ主催");
    const url = await createRoom(host, "読書会の会場");
    const code = new URL(url).pathname.split("/").pop();
    const room = db
      .collection("rooms")
      .doc((await db.collection("roomInvites").doc(code).get()).get("roomId"));
    const origin = "http://127.0.0.1:3157";
    const access = memberAccess(db, origin);
    const services = real
      ? await liveServices(process.env.MEETING_MAP_AI_PROJECT)
      : {
          recognize: async () => "会場を決めよう",
          predict: async (turns) => ({
            nodes: turns.map((t) => ({
              id: t.id + "_1",
              kind: "topic",
              status: "open",
              text: t.text,
              sourceUtteranceIds: [t.id],
            })),
            edges: [],
          }),
        };
    relay = memberGateway({ services, access, allowedOrigins: [web] });
    relay.server.listen(3157, "127.0.0.1");
    await once(relay.server, "listening");
    await join(host);
    await host.getByRole("button", { name: "議論マップを開く" }).click();
    await expect(
      host.getByText("現在、この部屋ではライブマップを利用できません。"),
    ).toBeVisible();
    await expect(
      host.getByRole("link", { name: "サンプルの議論マップを見る" }),
    ).toHaveAttribute("href", "/demo/map/ai");
    await settings.set({ enabled: true, origin, session: randomUUID() });
    expect(
      (
        await guest.request.post(web + "/api/meetings/" + room.id + "/map")
      ).status(),
    ).toBe(401);
    // The first browser's initial room had no map. Keep the owner out while the guest connects.
    await host.goto(web + "/rooms");
    await guest.goto(url);
    const other = await signInWithTestGoogle(
      guest,
      "map-guest@example.test",
      "マップ参加者",
    );
    await guest.getByRole("button", { name: "入室する", exact: true }).click();
    await expect(guest.getByRole("main").getByRole("alert")).toContainText(
      "文字起こしへの同意が必要",
    );
    expect(await guest.evaluate(() => window.micRequests)).toBe(0);
    expect(measurements.get(guest).tickets).toBe(0);
    await join(guest);
    await expect(callMic(guest)).toBeEnabled();
    expect(await guest.evaluate(() => window.micRequests)).toBe(0);
    const issued = host.waitForResponse("**/api/meetings/*/map");
    await host.goto(url);
    await expect(callMic(host)).toBeEnabled();
    await expect(guest.locator(".video-grid")).toContainText("マップ主催");
    await expect(host.locator(".video-grid")).toContainText("マップ参加者");
    for (const page of [host, guest]) {
      await expect(page.locator("#member-map")).toBeHidden();
      expect(await page.evaluate(() => window.micRequests)).toBe(0);
      expect(measurements.get(page).tickets).toBe(1);
    }
    const proof = await (await issued).json();
    const replay = new WebSocket(proof.url, { origin: web });
    await once(replay, "open");
    replay.send(JSON.stringify({ ...proof, type: "member" }));
    const [denial] = await once(replay, "message");
    expect(JSON.parse(denial.toString()).code).toBe("membership");
    // The guest reads the map while the host is still in the ordinary meeting.
    // Mobile browsers without the Fullscreen API use the same in-page view.
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.evaluate(() =>
      Object.defineProperty(document, "fullscreenEnabled", { value: false }),
    );
    await openMap(guest);
    const expand = guest.getByRole("button", { name: "全画面表示" });
    await expand.click();
    const dock = guest.getByRole("region", { name: "参加者の小窓" });
    await expect(dock.locator(".person-tile:visible")).toHaveCount(2);
    await expect(dock).toContainText("マップ主催");
    await expect(
      dock.getByRole("button", { name: "マイクをオン", exact: true }),
    ).toBeEnabled();
    const initial = await dock.boundingBox();
    expect(initial.x + initial.width).toBeLessThanOrEqual(390);
    expect(initial.y + initial.height).toBeLessThanOrEqual(844);
    await dock
      .getByRole("button", { name: "小窓の位置を変える" })
      .press("Enter");
    expect((await dock.boundingBox()).x).toBeLessThan(initial.x);
    await dock.getByRole("button", { name: "参加者の小窓を畳む" }).click();
    await expect(dock.locator(".video-grid")).toBeHidden();
    await dock.getByRole("button", { name: "参加者の小窓を広げる" }).click();
    await voice(host, guest, 1);
    await expect(guest.locator("[data-map-node]").first()).toBeVisible({
      timeout: real ? 95000 : 6000,
    });
    await expect(
      guest.getByRole("region", { name: "会話の字幕" }),
    ).toBeHidden();
    await guest
      .getByRole("button", { name: "字幕・操作", exact: true })
      .click();
    await expect(
      guest.getByRole("region", { name: "会話の字幕" }),
    ).toBeVisible();
    await guest.keyboard.press("Escape");
    await expect(expand).toBeFocused();
    await expect(
      guest.getByRole("region", { name: "あなたとAIメンバー" }),
    ).toBeVisible();
    await guest.getByRole("button", { name: "議論マップを閉じる" }).click();
    await voice(guest, host, 2);
    for (const page of [host, guest]) {
      expect(measurements.get(page).tickets).toBe(1);
      expect(await page.evaluate(() => window.micRequests)).toBe(1);
      await openMap(page);
    }
    await expect(
      host.locator(".live-captions li small", { hasText: "反映済み" }),
    ).toHaveCount(2, { timeout: 95000 });
    if (real) {
      await expect(guest.locator(".live-captions li").first()).toContainText(
        /マップ主催.*図書館/,
      );
      await expect(guest.locator(".live-captions li").nth(1)).toContainText(
        /マップ参加者.*予約/,
      );
    }
    const cards = (p) => p.locator("[data-map-node]");
    await expect(cards(host).first()).toBeVisible();
    await expect(cards(guest)).toHaveText(await cards(host).allTextContents());
    // Chromium's native exit (e.g. the browser's Escape control) also restores the same map.
    const hostExpand = host.getByRole("button", { name: "全画面表示" });
    await hostExpand.click();
    await expect
      .poll(() => host.evaluate(() => document.fullscreenElement?.tagName))
      .toBe("MAIN");
    await cards(host).last().click();
    const selected = await host.locator(".map-evidence-subject").textContent();
    await host.evaluate(() => document.exitFullscreen());
    await expect(hostExpand).toBeFocused();
    await expect(host.locator(".map-evidence-subject")).toHaveText(selected);
    await cards(guest).first().click();
    await expect(guest.locator(".map-quotes li").first()).toBeVisible();

    // The same organizer starts another meeting while the original pair is still connected.
    const second = await host.context().newPage();
    await second.goto(web);
    await createRoom(second, "倉庫の棚卸し");
    await join(second);
    await expect(callMic(second)).toBeEnabled();
    await openMap(second);
    await expect(cards(second)).toHaveCount(0);
    const firstCaptions = await host
      .locator(".live-captions li")
      .allTextContents();
    await second.getByText("文字で発言する", { exact: true }).click();
    await second
      .getByLabel("発言", { exact: true })
      .fill("倉庫の棚卸しは何曜日にしますか。木曜日を提案します。");
    await second.getByRole("button", { name: "発言を送る" }).click();
    await expect(cards(second).first()).toBeVisible({
      timeout: real ? 95000 : 5000,
    });
    await expect(second.locator(".live-captions li")).toHaveCount(1);
    expect(await host.locator(".live-captions li").allTextContents()).toEqual(
      firstCaptions,
    );
    await host.getByRole("button", { name: "マップの共有を終了" }).click();
    await host.getByRole("button", { name: "終了して消去" }).click();
    for (const page of [host, guest]) {
      await expect(cards(page)).toHaveCount(0);
      await expect(
        page.getByText(
          "字幕とマップの共有は終了しました。通話は続けられます。",
        ),
      ).toBeVisible();
      await expect(callMic(page)).toBeEnabled();
      expect(measurements.get(page).tickets).toBe(1);
    }
    await expect(
      guest.getByRole("button", { name: "新しいマップを開始" }),
    ).toHaveCount(0);
    const before = await host.evaluate(() => window.audible);
    await callMic(guest).click();
    await expect
      .poll(() => host.evaluate(() => window.audible), { timeout: 18000 })
      .toBeGreaterThan(before + 2);
    await guest
      .getByRole("button", { name: "マイクをオフ", exact: true })
      .click();
    expect(measurements.get(guest).turns).toBe(0);
    await host.getByRole("button", { name: "新しいマップを開始" }).click();
    await expect(guest.getByText("最初の発言を待っています")).toBeVisible();
    await guest.getByRole("button", { name: "議論マップを閉じる" }).click();
    await room.collection("members").doc(other.uid).update({ joined: false });
    await expect(
      guest.getByRole("alert").filter({ hasText: "参加状態が変わりました" }),
    ).toBeVisible();
    await expect(callMic(guest)).toBeDisabled();
    await expect(cards(second).first()).toBeVisible();
    await expect(second.locator(".live-captions li")).toContainText(
      "倉庫の棚卸し",
    );
    await expect(
      host.getByRole("complementary", { name: "進行メモ" }),
    ).toBeVisible();
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    await relay?.close();
    await settings.delete();
  }
});

async function startResearchGateway(db, origin, services) {
  if (!realResearch) {
    const relay = memberGateway({
      services,
      access: memberAccess(db, origin),
      allowedOrigins: [web],
    });
    relay.server.listen(3168, "127.0.0.1");
    await once(relay.server, "listening");
    return () => relay.close();
  }
  const relay = spawn(
    process.execPath,
    ["apps/web/.next/standalone/apps/web/scripts/run-member-map.mjs"],
    {
      env: {
        ...process.env,
        PORT: "3168",
        GOOGLE_CLOUD_PROJECT: "demo-meeting-auth",
        MEETING_VOICE_ENABLED: "1",
        MEETING_MAP_ORIGIN: origin,
        MEETING_MAP_WEB_ORIGIN: web,
      },
      stdio: "inherit",
    },
  );
  const stopped = once(relay, "exit");
  const close = () => {
    relay.kill();
    return stopped;
  };
  try {
    await expect
      .poll(
        () =>
          fetch(origin + "/health").then(
            (r) => r.ok,
            () => false,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}

test("members research a selected card or its pending check and share the cited result", async ({
  browser,
}) => {
  test.setTimeout(realResearch ? 175_000 : 60_000);
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8180");
  const db = getFirestore(
    initializeApp({ projectId: "demo-meeting-auth" }, "member-research-test"),
  );
  const settings = db.doc("roomMapSettings/default");
  const origin = "http://127.0.0.1:3168";
  const host = await browser.newPage();
  const guest = await browser.newPage();
  const graph = {
    nodes: [
      {
        id: "place",
        kind: "idea",
        status: "candidate",
        text: "東京タワーを見学する",
        sourceUtteranceIds: ["u01"],
      },
      {
        id: "height",
        kind: "question",
        status: "open",
        text: "東京タワーの塔の高さは何メートル？",
        sourceUtteranceIds: ["u01"],
      },
    ],
    edges: [
      {
        id: "height-place",
        from: "height",
        to: "place",
        relation: "asks_about",
      },
    ],
  };
  const services = {
    predict: async () => graph,
    research: async () => ({
      state: "answered",
      answer: "東京タワーの高さは333メートル。",
      source: {
        href: "https://www.tokyotower.co.jp/plan/towerpedia/",
        title: "タワペディア",
        publisher: "東京タワー",
      },
      relation: "informs",
    }),
  };
  const closeRelay = await startResearchGateway(db, origin, services);
  try {
    await settings.set({ enabled: true, origin, session: randomUUID() });
    await host.goto(web);
    await signInWithTestGoogle(host, "lookup-host@example.test", "主催者");
    const invite = await createRoom(host, "校外学習の見学先");
    await join(host);
    await guest.goto(invite);
    await signInWithTestGoogle(guest, "lookup-guest@example.test", "参加者");
    await guest.getByRole("button", { name: "入室する", exact: true }).click();
    await join(guest);
    for (const p of [host, guest])
      await p.getByRole("button", { name: "議論マップを開く" }).click();
    await host.getByText("文字で発言する", { exact: true }).click();
    await host
      .getByLabel("発言", { exact: true })
      .fill(
        "校外学習で訪れる見学先の候補に東京タワーを提案します。判断する前に確認したいのは、東京タワーの塔の高さが何メートルかです。高さはまだ分かりません。",
      );
    await host.getByRole("button", { name: "発言を送る" }).click();
    const check = host
      .locator(".map-pending-checks [data-kind=question]")
      .filter({ hasText: /高さ|何メートル/ })
      .first();
    await expect(check).toBeVisible({ timeout: realResearch ? 95_000 : 5000 });
    const id = await check.getAttribute("data-map-node");
    const direct = host
      .getByRole("region", { name: "議論のつながり" })
      .getByRole("button", { name: /(?:高さ|何メートル).*AIに調べてもらう/ });
    await direct.click();
    let href;
    for (const p of [host, guest]) {
      const sameCard = p.locator('[data-map-node="' + id + '"]');
      await expect(sameCard).toContainText(/333|３３３/, {
        timeout: realResearch ? 55_000 : 5000,
      });
      await sameCard.click();
      const source = p
        .getByRole("complementary", { name: "根拠の発言" })
        .getByRole("link", { name: /出典/ });
      const url = await source.getAttribute("href");
      expect(url).toMatch(/^https:\/\//);
      href ??= url;
      expect(url).toBe(href);
      await expect(
        sameCard.locator("..").getByRole("link", { name: /出典/ }),
      ).toHaveAttribute("href", href);
      await expect(
        p.getByRole("region", { name: "参考資料" }).getByRole("link"),
      ).toHaveAttribute("href", href);
    }
    if (realResearch) {
      const page = await host.request.get(href, { timeout: 12_000 });
      expect(page.ok()).toBe(true);
      expect(await page.text()).toMatch(/333|３３３/);
    } else {
      const idea = guest.locator('[data-map-node="place"]');
      await idea.click();
      await guest
        .getByRole("complementary", { name: "根拠の発言" })
        .getByRole("button", { name: /AIに調べてもらう/ })
        .click();
      await expect(
        host.getByRole("region", { name: "参考資料" }).getByRole("listitem"),
      ).toHaveCount(2);
      await expect(idea).toHaveAttribute("data-status", "candidate");
    }
  } finally {
    await Promise.all([guest.context().close(), host.context().close()]);
    await closeRelay();
    await settings.delete();
  }
});
