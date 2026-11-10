import { expect, test } from "@playwright/test";

// Google Fonts can be unavailable on a demo network. Use the system-font path
// so the browser checks depend only on the standalone server.
test.beforeEach(async ({ page }) => {
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ contentType: "text/css", body: "" }),
  );
});

test("the production server delivers the AInote landing page without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    errors.push(`Request failed: ${request.url()}`);
  });
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "AIも、話し合いのメンバー。",
  );
  await expect(
    page.getByRole("button", { name: "Googleでログイン" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("link", { name: "会議デモを試す" }),
  ).toHaveAttribute("href", "/home");
  expect(errors).toEqual([]);
});

test("the design preview carries the room settings and notes through the meeting", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "会議デモを試す" }).click();
  await page.getByRole("link", { name: /部屋を作る/ }).click();
  const topic = "ゼミの見学会を企画する";
  await page.getByLabel("話し合いのお題").fill(topic);
  await page.getByRole("radio", { name: "15分" }).check();
  await page.getByRole("radio", { name: "ピコ" }).check();
  await page.getByRole("button", { name: "部屋を作る" }).click();
  const dialog = page.getByRole("dialog", { name: "部屋ができました" });
  await expect(dialog.getByRole("textbox", { name: "招待リンク" })).toHaveValue(
    /\/r\/AINOTE$/,
  );
  await dialog.getByRole("link", { name: "部屋に入る" }).click();
  await expect(page.getByRole("heading", { name: topic })).toBeVisible();
  const enter = page.getByRole("button", { name: "入室する" });
  await enter.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "同意が必要",
  );
  await page.getByRole("checkbox", { name: /文字に起こす/ }).check();
  await enter.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(topic);
  await expect(page.locator(".ai-tile .tile-label")).toHaveText("ピコAI");
  await page.getByRole("button", { name: "この進め方で始める" }).click();
  const memo = "日程の候補を二つに絞る。";
  await page.getByLabel("メモを書き足す").fill(memo);
  await page.getByRole("button", { name: "追記する" }).click();
  await expect(page.locator(".part-row.current")).toContainText(memo);
  await page.getByRole("button", { name: "退室" }).click();
  await page.getByRole("link", { name: /戻る/ }).click();
  await page.getByRole("checkbox", { name: /文字に起こす/ }).check();
  await enter.click();
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "次へ", exact: true }).click();
  await page.getByRole("button", { name: "話せた", exact: true }).click();
  await page.getByRole("button", { name: "部屋を終える" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(topic);
  await expect(page.getByText(memo, { exact: true })).toBeVisible();
  await expect(page.locator(".private-note")).toContainText("話せた");
  await page.getByRole("link", { name: "ホームへ", exact: true }).click();
  const savedNote = page.getByRole("link", { name: new RegExp(topic) });
  await expect(savedNote).toBeVisible();
  await page.getByRole("link", { name: /部屋を作る/ }).click();
  await page.getByLabel("話し合いのお題").fill("次の話し合い");
  await page.getByRole("button", { name: "部屋を作る" }).click();
  await page.getByRole("link", { name: "あとで" }).click();
  await savedNote.click();
  await expect(page.getByText(memo, { exact: true })).toBeVisible();
});

test("the sample invite opens preflight and an unknown code explains how to return", async ({
  page,
}) => {
  await page.goto("/home?view=first");
  await expect(
    page.getByRole("heading", { name: "最初の話し合いを始めましょう" }),
  ).toBeVisible();
  const code = page.getByRole("textbox", { name: "招待コードで入る" });
  await code.fill("xxxxxx");
  await page.getByRole("button", { name: "入る", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "招待が使えません" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "ホームへ", exact: true }).click();
  await code.fill("ainote");
  await page.getByRole("button", { name: "入る", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/demo\/join$/);
});

test("liveness crosses the real HTTP boundary without caching", async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-request-id"]).toBeTruthy();
  expect(await response.json()).toMatchObject({ status: "ok" });
});

test("the voice probe requires consent and a valid operator key before opening the microphone", async ({
  page,
  request,
}) => {
  await page.goto("/voice-probe");
  const start = page.getByRole("button", { name: "音声テストを始める" });
  await expect(start).toBeDisabled();
  await page.getByLabel("検証キー").fill("invalid");
  await expect(start).toBeDisabled();
  await page.getByRole("checkbox").check();
  await start.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "検証キー",
  );
  const denied = await request.post("/api/internal/voice-probe");
  expect(denied.status()).toBe(404);
  expect(denied.headers()["cache-control"]).toContain("no-store");
});

test("planning automatically starts the edited agenda after three minutes", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/rooms/demo");
  await expect(page.locator(".clock-chip")).toHaveText("3:00");
  await page.getByLabel("パート1の名前").fill("検討したいテーマ");
  await page.clock.fastForward(180000);
  await page.clock.runFor(1000);
  await expect(page.locator(".part-row.current")).toContainText(
    "検討したいテーマ",
  );
});

test("invalid invitation and room URLs return HTTP 404", async ({
  request,
}) => {
  for (const path of [
    "/r/invalid-code",
    "/r/ZZZZZZ?demo=1",
    "/rooms/missing",
    "/rooms/missing/join",
  ]) {
    expect((await request.get(path)).status()).toBe(404);
  }
});
