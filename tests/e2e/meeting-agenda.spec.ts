import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { signInWithTestGoogle } from "./sign-in";

// Start close to a real server-time boundary so both browser and API see it.
async function seedAgenda(
  code: string,
  members: string[],
  timing: { planningAt: number; confirmedAt: number | null },
) {
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8180");
  const db = getFirestore(initializeApp({ projectId: "demo-meeting-auth" }));
  const room = db.collection("rooms").doc(randomUUID());
  const rows = [
    { partId: "part-0", name: "条件", minutes: 8 },
    { partId: "part-1", name: "比較", minutes: 10 },
    { partId: "part-2", name: "決定", minutes: 10 },
    { partId: "part-3", name: "振り返り", minutes: 2 },
  ];
  const seed = db.batch();
  seed.set(db.collection("roomInvites").doc(code), { roomId: room.id });
  seed.set(room, {
    code,
    topic: "予定の共同編集",
    minutes: 30,
    member: "ノト",
    ownerUid: members[0],
    status: "open",
    agendaV2: {
      version: 9,
      ...timing,
      parts: rows,
      numberedParts: [],
      nextPartNumber: 4,
    },
  });
  for (const uid of members)
    seed.set(room.collection("members").doc(uid), {
      joined: true,
      version: 1,
    });
  await seed.commit();
  return room;
}

test("two participants keep drafts across auto-start, notes and conflicting plan edits", async ({
  page,
  browser,
}) => {
  test.slow();
  const other = await browser.newContext();
  try {
    const guest = await other.newPage();
    const tabs = [page, guest];
    const [host, member] = await Promise.all(
      tabs.map(async (tab, i) => {
        await tab.goto("/");
        return signInWithTestGoogle(
          tab,
          `agenda-${i}@example.test`,
          i ? "参加者" : "主催者",
        );
      }),
    );
    const code = "AGND45";
    const room = await seedAgenda(code, [host!.uid, member!.uid], {
      planningAt: Date.now() - 165_000,
      confirmedAt: null,
    });
    await Promise.all(tabs.map((tab) => tab.goto("/r/" + code)));
    const minutes = page.getByRole("spinbutton", {
      name: "パート2の時間（分）",
    });
    await minutes.fill("");
    await expect(
      page.getByRole("button", { name: "この進め方で始める" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "進行メモを閉じる" }).click();
    await page.getByRole("button", { name: "進行メモを開く" }).click();
    await expect(minutes).toHaveValue("");
    await page.getByRole("button", { name: "比較を上へ移動" }).click();
    const save = page.getByRole("button", { name: "予定を保存する" });
    await expect(page.getByText(/「条件」が始まりました/)).toBeVisible({
      timeout: 25_000,
    });
    await expect(save).toBeDisabled();
    await expect(page.getByLabel("パート1の名前")).toHaveValue("比較");
    await page
      .getByRole("button", { name: "進行に合わせて下書きを直す" })
      .click();
    await expect(save).toBeEnabled();
    await expect(page.getByLabel("パート1の名前")).toHaveValue("条件");
    await expect(minutes).toHaveValue("");
    await minutes.fill("8");
    await guest.getByLabel("共有メモを書き足す").fill("予算を確認した");
    await guest.getByRole("button", { name: "追記する" }).click();
    await expect(page.getByText("予算を確認した", { exact: true })).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(minutes).toHaveValue("8");
    expect((await room.get()).get("agendaV3")).toMatchObject({
      version: 10,
      planVersion: 9,
    });
    await guest.getByRole("button", { name: "予定を編集する" }).click();
    await guest.getByLabel("パート3の名前").fill("候補を決める");
    await guest.getByRole("button", { name: "予定を保存する" }).click();
    await expect(page.getByText("最新の案", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("listitem").filter({ hasText: "候補を決める（10分）" }),
    ).toBeVisible();
    await expect(minutes).toHaveValue("8");
    await expect(save).toBeDisabled();
    await page
      .getByRole("button", { name: "下書きを破棄して最新の案から編集" })
      .click();
    await expect(minutes).toHaveValue("10");
    await expect(page.getByLabel("パート3の名前")).toHaveValue("候補を決める");
    await minutes.fill("5");
    await page.getByLabel("パート3の時間（分）").fill("15");
    await guest.getByLabel("共有メモを書き足す").fill("比較条件を追加");
    await Promise.all([
      save.click(),
      guest.getByRole("button", { name: "追記する" }).click(),
    ]);
    for (const tab of tabs) {
      await expect(
        tab.locator("summary").filter({ hasText: "候補を決める" }),
      ).toContainText("15分", { timeout: 15_000 });
      await expect(
        tab.getByText("比較条件を追加", { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
    }
    expect((await room.get()).get("agendaV3")).toMatchObject({
      version: 13,
      planVersion: 11,
      confirmedAt: null,
    });
  } finally {
    await other.close();
  }
});

test("recovers an expired extension while keeping later edits in the draft", async ({
  page,
}) => {
  test.slow();
  await page.goto("/");
  const { uid } = await signInWithTestGoogle(
    page,
    "agenda-boundary@example.test",
    "参加者",
  );
  const code = "AGND46";
  const confirmedAt = Date.now() - 8 * 60_000 + 20_000;
  const room = await seedAgenda(code, [uid], {
    planningAt: confirmedAt - 180_000,
    confirmedAt,
  });
  await page.goto("/r/" + code);
  await page.getByRole("button", { name: "予定を編集する" }).click();
  const firstMinutes = page.getByLabel("パート1の時間（分）");
  const save = page.getByRole("button", { name: "予定を保存する" });
  await firstMinutes.fill("7");
  await save.click();
  const alert = page
    .getByRole("complementary", { name: "進行メモ" })
    .getByRole("alert");
  await expect(alert).toContainText("終了を現在時刻より後にしてください");
  await firstMinutes.fill("9");
  await expect(alert).toBeHidden();
  await page.getByLabel("パート2の名前").fill("比較の論点");
  await page.getByLabel("パート3の時間（分）").fill("9");
  await expect(page.getByText(/「条件」は終了しました/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(save).toBeDisabled();
  await expect(firstMinutes).toHaveValue("9");
  await page
    .getByRole("button", { name: "進行に合わせて下書きを直す" })
    .click();
  await expect(firstMinutes).toHaveValue("8");
  await expect(page.getByLabel("パート2の名前")).toHaveValue("比較の論点");
  await expect(page.getByLabel("パート3の時間（分）")).toHaveValue("9");
  expect((await room.get()).get("agendaV3")).toBeUndefined();
  await save.click();
  await expect(
    page.getByRole("button", { name: "予定を編集する" }),
  ).toBeVisible();
  expect((await room.get()).get("agendaV3")).toMatchObject({
    planVersion: 10,
    parts: [
      { name: "条件", minutes: 8 },
      { name: "比較の論点", minutes: 10 },
      { name: "決定", minutes: 9 },
      { name: "振り返り", minutes: 2 },
    ],
  });
});

test("a manual edit invalidates the displayed AI proposal on both participants' screens", async ({
  page,
  browser,
}) => {
  const other = await browser.newContext();
  try {
    const guest = await other.newPage();
    const tabs = [page, guest];
    const members = await Promise.all(
      tabs.map(async (tab, i) => {
        await tab.goto("/");
        return (
          await signInWithTestGoogle(
            tab,
            `proposal-${i}@example.test`,
            i ? "参加者" : "主催者",
          )
        ).uid;
      }),
    );
    const code = "AGND47";
    const room = await seedAgenda(code, members, {
      planningAt: Date.now() - 185_000,
      confirmedAt: null,
    });
    const id = randomUUID();
    await room.update({
      pendingAgendaProposal: {
        proposal: {
          id,
          basePlanVersion: 9,
          reason: "会場費の条件を反映",
          operations: [
            { action: "rename", target: "part-1", name: "3万円以内で比較" },
          ],
        },
        changes: ["「比較」 → 「3万円以内で比較」"],
      },
    });
    await Promise.all(tabs.map((tab) => tab.goto("/r/" + code)));
    for (const tab of tabs)
      await expect(
        tab.getByRole("region", { name: "AIによる予定変更" }),
      ).toContainText("3万円以内で比較");
    // Hold only the approval in flight while the other participant changes the plan.
    const saved = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/agenda/v2"),
    );
    const rejected = guest.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/agenda/v2"),
    );
    await guest.route("**/agenda/v2", async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().postDataJSON().action === "approve"
      ) {
        await saved;
      }
      await route.continue();
    });
    const submitted = guest.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith("/agenda/v2"),
    );
    await guest.getByRole("button", { name: "この変更を反映する" }).click();
    await submitted;
    await page.getByRole("button", { name: "予定を編集する" }).click();
    await page.getByLabel("パート2の名前").fill("人が決めた比較条件");
    await page.getByRole("button", { name: "予定を保存する" }).click();
    const withdrawn = "予定が変わったため、AIの変更案を取り下げました。";
    await expect(page.getByText(withdrawn, { exact: true })).toBeVisible();
    expect((await rejected).status()).toBe(409);
    for (const tab of tabs) {
      await expect(
        tab.getByRole("button", { name: "この変更を反映する" }),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        tab.locator("summary").filter({ hasText: "人が決めた比較条件" }),
      ).toBeVisible();
    }
    await expect(guest.getByText(withdrawn, { exact: true })).toBeVisible();
    await page.getByLabel("共有メモを書き足す").fill("予算を確認");
    await page.getByRole("button", { name: "追記する" }).click();
    await expect(page.getByText("予算を確認", { exact: true })).toBeVisible();
    await expect(page.getByText(withdrawn, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "予定を編集する" }).click();
    await page.getByLabel("パート3の名前").fill("予定を再確認");
    await page.getByRole("button", { name: "予定を保存する" }).click();
    for (const tab of tabs) {
      await expect(
        tab.locator("summary").filter({ hasText: "予定を再確認" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(tab.getByText(withdrawn, { exact: true })).toHaveCount(0);
    }
    await guest.reload();
    await expect(
      guest.locator("summary").filter({ hasText: "予定を再確認" }),
    ).toBeVisible();
    await expect(guest.getByText(withdrawn, { exact: true })).toHaveCount(0);
    expect((await room.get()).get("agendaV3.planVersion")).toBe(11);
  } finally {
    await other.close();
  }
});

test("a former member can reopen the finished notebook and an unjoined user cannot", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  const member = await signInWithTestGoogle(
    page,
    "past-participant@example.test",
    "参加者",
  );
  const code = "NTEB45";
  const room = await seedAgenda(code, [member.uid], {
    planningAt: Date.now() - 10_000,
    confirmedAt: Date.now(),
  });
  await room
    .collection("members")
    .doc(member.uid)
    .update({ joined: false, version: 2 });
  await page.goto("/r/" + code);
  await expect(page.getByRole("button", { name: "再入室する" })).toBeVisible();
  await expect(page.getByRole("link", { name: "終了後のノート" })).toHaveCount(
    0,
  );
  const result = {
    id: randomUUID(),
    deadline: Date.now(),
    status: "verified",
    question: "会場費はいくら？",
    finding: {
      answer: "合成例の料金は1万円です。",
      conditions: "全日・市内",
      publisher: "施設",
      title: "施設利用料金表",
      url: "https://www.f-cp.jp/shimin/guide/guide05/#c01",
    },
  };
  await room.update({ status: "closed", research: [result] });
  await room
    .collection("phaseNotes")
    .doc("test-entry")
    .set({ partId: "part-0", text: "会場費の上限は3万円", createdAt: 1 });
  await page.goto("/r/" + code);
  await page.getByRole("link", { name: "話し合いのノート" }).click();
  await expect(page).toHaveURL("/rooms/" + room.id + "/note");
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveAttribute(
    "href",
    "/",
  );
  await expect(
    page
      .locator("details")
      .filter({ has: page.getByText("条件", { exact: true }) }),
  ).toContainText("会場費の上限は3万円");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  const sources = page.getByRole("region", { name: "参考資料" });
  await expect(sources).toContainText(result.finding.answer);
  await expect(sources).toContainText(result.finding.conditions);
  await expect(sources.getByRole("link")).toHaveAttribute(
    "href",
    result.finding.url,
  );
  const other = await browser.newContext();
  try {
    const tab = await other.newPage();
    await tab.goto("/");
    const login = tab.waitForRequest(
      (r) => r.url().endsWith("/api/auth/me") && r.method() === "PUT",
    );
    await signInWithTestGoogle(tab, "note-outsider@example.test", "未入室");
    const authorization = (await (await login).headerValue("authorization"))!;
    const headers = { authorization };
    expect(
      (
        await tab.request.get("/api/meetings/" + room.id + "/note", { headers })
      ).status(),
    ).toBe(403);
    const dbUrl =
      "http://127.0.0.1:8180/v1/projects/demo-meeting-auth/databases/(default)/documents/";
    expect(
      (await tab.request.get(dbUrl + room.path, { headers })).status(),
    ).toBe(403);
    await tab.goto("/rooms/" + room.id + "/note");
    await expect(tab.getByRole("alert")).toBeVisible();
    await expect(tab.getByText("会場費の上限は3万円")).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test("a room page expires pending research when no worker posts a result", async ({
  page,
}) => {
  await page.goto("/");
  const { uid } = await signInWithTestGoogle(
    page,
    "research-timeout@example.test",
    "主催者",
  );
  const room = await seedAgenda("SRCB45", [uid], {
    planningAt: Date.now(),
    confirmedAt: null,
  });
  await room.update({
    research: [
      {
        id: randomUUID(),
        status: "pending",
        question: "休日の利用料金は？",
        deadline: Date.now() + 6500,
      },
    ],
  });
  await page.goto("/r/SRCB45");
  const sources = page.getByRole("region", { name: "参考資料" });
  await expect(sources).toContainText("調べています");
  await expect(sources).toContainText("時間切れ", { timeout: 10000 });
  await page.reload();
  await expect(sources).toContainText("時間切れ");
});
