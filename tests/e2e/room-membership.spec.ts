import { expect, test, type Page } from "@playwright/test";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { signInWithTestGoogle } from "./sign-in";

async function enter(page: Page, button: string) {
  await page.getByRole("checkbox", { name: /18歳以上/ }).check();
  await page.getByRole("checkbox", { name: /文字に起こす/ }).check();
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect(
    page.getByRole("region", { name: "あなたとAIメンバー" }),
  ).toBeVisible();
}

test("two Google users join the same room; leaving and rejoining preserves each membership", async ({
  page,
  browser,
}) => {
  test.slow();
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8180");
  const db = getFirestore(initializeApp({ projectId: "demo-meeting-auth" }));
  const guestContext = await browser.newContext({
    viewport: { width: 375, height: 812 },
  });
  try {
    await page.goto("/");
    const host = await signInWithTestGoogle(
      page,
      "room-host@example.test",
      "主催テスト",
    );
    await page.getByRole("link", { name: "部屋を開く" }).click();
    await expect(
      page.getByRole("heading", { name: "自分の部屋" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "ホームへ", exact: true }).click();
    await expect(page).toHaveURL("/");
    await page.getByRole("link", { name: "部屋を開く" }).click();
    await page.getByRole("link", { name: /部屋を作る/ }).click();
    await expect(
      page.getByRole("link", { name: "ホームへ", exact: true }),
    ).toHaveAttribute("href", "/");
    await page.getByLabel("話し合いのお題").fill("二人の読書会");
    await page.getByRole("radio", { name: "45分" }).check();
    await page.getByRole("radio", { name: "ピコ" }).check();
    await page.getByRole("button", { name: "部屋を作る" }).click();
    const dialog = page.getByRole("dialog", { name: "部屋ができました" });
    const url = await dialog.getByLabel("招待リンク").inputValue();
    const code = new URL(url).pathname.split("/").pop()!;
    const invite = await db.collection("roomInvites").doc(code).get();
    const room = db.collection("rooms").doc(invite.get("roomId"));
    expect((await room.get()).get("ownerUid")).toBe(host.uid);
    const hostRecord = room.collection("members").doc(host.uid);
    await dialog.getByRole("link", { name: "部屋に入る" }).click();
    await expect(
      page.getByRole("heading", { name: "入室前の確認" }),
    ).toBeVisible();
    await expect(page.getByText("主催テスト（あなた）")).toBeVisible();
    await page.getByRole("button", { name: "入室する" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "同意が必要",
    );
    expect((await hostRecord.get()).exists).toBe(false);
    await enter(page, "入室する");
    await page.reload();
    const stage = page.getByRole("region", { name: "あなたとAIメンバー" });
    await expect(stage.getByText("主催テスト（あなた）")).toBeVisible();
    await expect(stage.getByText("ピコ", { exact: false })).toBeVisible();
    await expect(stage.getByText("未接続", { exact: true })).toBeVisible();
    await expect(page.locator(".clock-chip")).toContainText("開始前45:00");
    await stage.getByRole("button", { name: "議論マップを開く" }).click();
    const map = page.getByRole("region", { name: "部屋の議論マップ" });
    await expect(map).toBeVisible();
    await expect(map.getByRole("button", { name: "マイクをオン" })).toHaveCount(
      0,
    );
    await stage.getByRole("button", { name: "議論マップを閉じる" }).click();
    const agenda = page.getByRole("complementary", { name: "進行メモ" });
    await expect(agenda.getByText("考えを持ち寄る")).toBeVisible();
    await page.getByRole("button", { name: "招待", exact: true }).click();
    const share = page.getByRole("dialog", { name: "メンバーを招待" });
    await expect(share.getByText(code, { exact: true })).toBeVisible();
    await expect(
      share.getByRole("textbox", { name: "招待リンク" }),
    ).toHaveValue(url);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(url).origin,
      });
    await share.getByRole("button", { name: "招待リンクをコピー" }).click();
    await expect(share.getByRole("status")).toHaveText("コピーしました");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await page.keyboard.press("Escape");
    await expect(share).not.toBeVisible();
    const first = (await hostRecord.get()).get("firstJoinedAt");
    expect(first).toBeInstanceOf(Timestamp);

    const guestPage = await guestContext.newPage();
    await guestPage.goto(url);
    await expect(
      guestPage.getByRole("heading", {
        name: "部屋に入るにはログインしてください",
      }),
    ).toBeVisible();
    const guest = await signInWithTestGoogle(
      guestPage,
      "room-guest@example.test",
      "参加テスト",
    );
    await enter(guestPage, "入室する");
    await guestPage.clock.setFixedTime(Date.now() + 10 * 60_000);
    await expect(guestPage.getByText("参加テスト（あなた）")).toBeVisible();
    await expect(guestPage.getByText("参加者 · 入室中")).toBeVisible();
    expect(
      await guestPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const guestRecord = room.collection("members").doc(guest.uid);
    expect((await guestRecord.get()).get("joined")).toBe(true);
    const guestAgenda = guestPage.getByRole("complementary", {
      name: "進行メモ",
    });
    await expect(
      guestAgenda.getByText(/主催者が話し合いを始めるのを/),
    ).toBeVisible();
    await agenda.getByRole("button", { name: "話し合いを始める" }).click();
    await expect(page.locator(".clock-chip")).toContainText("準備の残り");
    await agenda
      .getByRole("textbox", { name: "パート1の名前" })
      .fill("選書の条件");
    const before = (await room.get()).get("agendaV3.parts") as {
      partId: string;
    }[];
    await agenda
      .getByRole("spinbutton", { name: "パート2の時間（分）" })
      .fill("24");
    await agenda.getByRole("button", { name: "パートを追加" }).click();
    await agenda.getByRole("button", { name: "パートを追加" }).click();
    await agenda.getByRole("textbox", { name: "パート4の名前" }).fill("  ");
    await expect(
      agenda.getByRole("button", { name: "パート4を上へ移動", exact: true }),
    ).toBeEnabled();
    await agenda
      .getByRole("button", { name: "パート5を上へ移動", exact: true })
      .click();
    await expect(
      agenda.getByRole("textbox", { name: "パート5の名前" }),
    ).toHaveValue("  ");
    await agenda
      .getByRole("button", { name: "パート5を削除", exact: true })
      .click();
    await agenda
      .getByRole("textbox", { name: "パート4の名前" })
      .fill("二冊を比べる");
    await agenda
      .getByRole("button", { name: "二冊を比べるを上へ移動" })
      .click();
    await expect(
      agenda.getByRole("textbox", { name: "パート3の名前" }),
    ).toHaveValue("二冊を比べる");
    const savedResponse = page.waitForResponse(
      (r) => r.url().endsWith("/agenda/v2") && r.request().method() === "POST",
    );
    await agenda.getByRole("button", { name: "案を共有する" }).click();
    const saved = await savedResponse;
    expect(saved.status()).toBe(200);
    const after = (await room.get()).get("agendaV3.parts") as {
      partId: string;
      name: string;
      minutes: number;
    }[];
    expect(after.map((part) => part.partId)).toEqual([
      before[0]!.partId,
      before[1]!.partId,
      expect.any(String),
      before[2]!.partId,
      before[3]!.partId,
    ]);
    expect(new Set(after.map((part) => part.partId)).size).toBe(5);
    // The previous fixed-ID UI uses the same URL but only sends the display revision.
    const previousClient = await page.request.post(saved.url(), {
      headers: {
        Authorization: (await saved.request().headerValue("authorization"))!,
      },
      data: {
        action: "save",
        version: (await room.get()).get("agendaV3.version"),
        parts: after,
      },
    });
    expect(previousClient.status()).toBe(409);
    expect(await previousClient.json()).toMatchObject({
      code: "reload-required",
    });
    const oldUrl = saved.url().replace(/\/v2$/, "");
    const oldClient = await page.request.post(oldUrl, {
      headers: {
        Authorization: (await saved.request().headerValue("authorization"))!,
      },
      data: {
        action: "save",
        version: (await room.get()).get("agendaV3.version"),
        parts: after.map(({ name, minutes }) => ({ name, minutes })),
      },
    });
    expect(oldClient.status()).toBe(409);
    expect(await oldClient.json()).toMatchObject({
      code: "reload-required",
      message: expect.stringContaining("再読み込み"),
    });

    const oldView = await page.request.get(oldUrl + "?since=1", {
      headers: {
        Authorization: (await saved.request().headerValue("authorization"))!,
      },
    });
    expect(await oldView.json()).toMatchObject({
      parts: [{ name: expect.stringContaining("再読み込み"), notes: [] }],
    });

    await expect(
      guestAgenda.getByRole("textbox", { name: "パート1の名前" }),
    ).toHaveValue("選書の条件", { timeout: 15000 });
    await guestAgenda
      .getByRole("button", { name: "この進め方で始める" })
      .click();
    await expect(agenda.locator('[aria-current="step"]')).toContainText(
      "選書の条件",
      { timeout: 15000 },
    );
    await expect(page.locator(".clock-chip")).toContainText("全体の残り");
    const clock = page.getByRole("timer");
    const firstTime = await clock.innerText();
    await expect(clock).not.toHaveText(firstTime);
    const [hostRemaining, guestRemaining] = await Promise.all(
      [page, guestPage].map(async (tab) => {
        const [m, s] = (await tab.getByRole("timer").innerText())
          .split(":")
          .map(Number);
        return m! * 60 + s!;
      }),
    );
    expect(Math.abs(hostRemaining! - guestRemaining!)).toBeLessThanOrEqual(2);
    await Promise.all([
      agenda.getByLabel("共有メモを書き足す").fill("次回は短編を読む"),
      guestAgenda
        .getByLabel("共有メモを書き足す")
        .fill("候補を二冊ずつ持ち寄る"),
    ]);
    await Promise.all(
      [agenda, guestAgenda].map((panel) =>
        panel.getByRole("button", { name: "追記する" }).click(),
      ),
    );
    for (const panel of [agenda, guestAgenda]) {
      await expect(
        panel.getByText("次回は短編を読む", { exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await expect(
        panel.getByText("候補を二冊ずつ持ち寄る", { exact: true }),
      ).toBeVisible({ timeout: 15000 });
    }
    const confirmedAt = (await room.get()).get("agendaV3.confirmedAt");
    await page.getByRole("button", { name: "退室する" }).click();
    await expect(
      page.getByRole("heading", { name: "退室しました" }),
    ).toBeVisible();
    const afterLeave = await hostRecord.get();
    expect(afterLeave.get("lastLeftAt")).toBeInstanceOf(Timestamp);
    expect(afterLeave.get("joined")).toBe(false);
    expect((await guestRecord.get()).get("joined")).toBe(true);
    expect((await room.get()).get("status")).toBe("open");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "再入室する" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "ホームへ" }).click();
    await expect(page).toHaveURL("/");
    await page.getByRole("link", { name: "部屋を開く" }).click();
    // A retry can leave another room with the same topic in this user's history.
    await page
      .getByRole("link", { name: "二人の読書会" })
      .and(page.locator(`a[href="/r/${code}"]`))
      .click();
    await enter(page, "再入室する");
    await expect(
      agenda.getByText("次回は短編を読む", { exact: true }),
    ).toBeVisible();
    expect((await room.get()).get("agendaV3.confirmedAt")).toBe(confirmedAt);
    const rejoined = await hostRecord.get();
    expect(rejoined.get("firstJoinedAt")).toEqual(first);
    expect(rejoined.get("lastLeftAt")).toEqual(afterLeave.get("lastLeftAt"));
    expect(rejoined.get("lastJoinedAt").toMillis()).toBeGreaterThan(
      first.toMillis(),
    );
    expect((await room.collection("members").get()).size).toBe(2);
    // Resume an existing room just after the first phase's deadline in the emulator.
    await room.update({
      "agendaV3.confirmedAt": Date.now() - 15 * 60_000 - 2000,
      "agendaV3.version": FieldValue.increment(1),
      "agendaV3.planVersion": FieldValue.increment(1),
    });
    await expect(agenda.locator('[aria-current="step"]')).toContainText(
      "アイデアを深める",
      { timeout: 15000 },
    );
    await expect(
      agenda.getByText("次回は短編を読む", { exact: true }),
    ).toBeHidden();
    await agenda.locator("summary").filter({ hasText: "選書の条件" }).click();
    await expect(
      agenda.getByText("次回は短編を読む", { exact: true }),
    ).toBeVisible();
    await guestPage.getByRole("link", { name: "ホームへ" }).click();
    await expect(guestPage).toHaveURL("/");
    await guestPage.getByRole("link", { name: "部屋を開く" }).click();
    await guestPage
      .getByRole("textbox", { name: "招待コードで入る" })
      .fill(code.toLowerCase());
    await guestPage.getByRole("button", { name: "入る", exact: true }).click();
    await expect(
      guestPage.getByRole("region", { name: "あなたとAIメンバー" }),
    ).toBeVisible();
    // A visit that previously received a ticket still needs eviction even
    // after the operator removed LiveKit configuration (as in this suite).
    await guestRecord.update({
      voiceVersion: (await guestRecord.get()).get("version"),
    });
    const pending = () =>
      guestPage.waitForResponse(
        (r) =>
          r.url().endsWith("/membership") && r.request().method() === "PUT",
      );
    const firstLeave = pending();
    await guestPage.getByRole("button", { name: "退室する" }).click();
    expect((await firstLeave).status()).toBe(503);
    await expect(
      guestPage.getByRole("heading", { name: "退室処理中" }),
    ).toBeVisible();
    await guestPage.reload();
    const retryLeave = guestPage.getByRole("button", { name: "退室を再試行" });
    await expect(retryLeave).toBeEnabled();
    const retryResult = pending();
    await retryLeave.click();
    expect((await retryResult).status()).toBe(503);
    expect((await guestRecord.get()).data()).toMatchObject({
      joined: true,
      voiceLeaving: true,
    });
    await guestPage.goto("/r/000000");
    await expect(guestPage.getByRole("main").getByRole("alert")).toHaveText(
      "この招待コードの部屋が見つかりません。",
    );
  } finally {
    await guestContext.close();
  }
});

test("room APIs require login even with an invite code", async ({
  request,
}) => {
  for (const [method, path] of [
    ["GET", "/api/rooms"],
    ["POST", "/api/rooms"],
    ["GET", "/api/rooms/ABC234/membership"],
    ["PUT", "/api/rooms/ABC234/membership"],
    ["GET", "/api/meetings/2495a326-91fe-4a3d-931e-4593f77fabd2/agenda"],
    ["POST", "/api/meetings/2495a326-91fe-4a3d-931e-4593f77fabd2/agenda"],
    ["GET", "/api/meetings/2495a326-91fe-4a3d-931e-4593f77fabd2/agenda/v2"],
    ["POST", "/api/meetings/2495a326-91fe-4a3d-931e-4593f77fabd2/agenda/v2"],
  ] as const) {
    expect((await request.fetch(path, { method })).status()).toBe(401);
  }
});
