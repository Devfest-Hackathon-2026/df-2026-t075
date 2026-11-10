import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { gateway } from "../../apps/web/scripts/live-map/gateway.mjs";

test("invited browsers see the same map; only the operator creates or ends a room, and closing revokes the invitation", async ({
  browser,
}) => {
  const hostPort = 3147,
    guestPort = 3148;
  const app = gateway({
    appRoot: resolve("apps/web"),
    hostPort,
    guestPort,
    services: {
      predict: async (turns) => ({
        nodes: turns.map((t) => ({
          id: t.id + "_1",
          kind: "topic",
          status: "open",
          text: "論点：" + t.text,
          sourceUtteranceIds: [t.id],
        })),
        edges: [],
      }),
    },
  });
  await app.start();
  const host = await browser.newPage(),
    guest = await browser.newPage(),
    stranger = await browser.newPage();
  const url = (p) => `http://127.0.0.1:${p}/demo/map/live`;
  const packet = (message) =>
    new Promise((ok, no) => {
      const ws = new WebSocket(`ws://127.0.0.1:${guestPort}/live-map/socket`, {
        origin: `http://127.0.0.1:${guestPort}`,
      });
      ws.once("open", () => ws.send(JSON.stringify(message)));
      ws.once("message", (b) => {
        ws.close();
        ok(JSON.parse(b));
      });
      ws.once("error", no);
    });
  async function form(page, name) {
    await page.getByLabel("表示名").fill(name);
    await page.getByRole("checkbox").check();
  }
  try {
    expect(
      await packet({ type: "create", consent: true, name: "別端末" }),
    ).toEqual({ type: "error", code: "invite" });
    await host.goto(url(hostPort));
    await form(host, "主催");
    await host.getByRole("button", { name: "デモの部屋を作る" }).click();
    await host.getByText("メンバーを招待", { exact: true }).click();
    const invite = await host
      .getByLabel("招待リンク", { exact: true })
      .inputValue();
    expect(
      await packet({
        type: "join",
        name: "同意前",
        invite: new URL(invite).hash.slice(1),
      }),
    ).toEqual({ type: "error", code: "invalid" });
    await guest.goto(invite);
    await form(guest, "参加者乙");
    await guest.getByRole("button", { name: "入室する" }).click();
    await expect(host.locator(".live-people")).toContainText("参加者乙");
    await expect(guest.getByRole("button", { name: "部屋を終了" })).toHaveCount(
      0,
    );
    await guest.getByText("文字で発言する", { exact: true }).click();
    await guest.getByLabel("発言", { exact: true }).fill("開催日を決めよう");
    await guest.getByRole("button", { name: "発言を送る" }).click();
    const card = (p) => p.locator("[data-map-node]").first();
    await expect(card(host)).toContainText("開催日を決めよう");
    await expect(card(guest)).toHaveText(await card(host).innerText(), {
      useInnerText: true,
    });
    await guest.reload();
    await guest.getByRole("button", { name: "再接続" }).click();
    await expect(card(guest)).toContainText("開催日を決めよう");
    await host.getByRole("button", { name: "部屋を終了" }).click();
    await host.getByRole("button", { name: "終了して消去" }).click();
    await expect(guest.getByRole("status")).toContainText("消去しました");
    await stranger.goto(invite);
    await form(stranger, "別の人");
    await stranger.getByRole("button", { name: "入室する" }).click();
    await expect(stranger.getByRole("main").getByRole("alert")).toContainText(
      "部屋が終了",
    );
    await expect(stranger.locator("[data-map-node]")).toHaveCount(0);
  } finally {
    await Promise.all([host.close(), guest.close(), stranger.close()]);
    await app.close();
  }
});
