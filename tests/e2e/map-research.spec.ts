import { expect, test } from "@playwright/test";

test("a card request and a spoken example return one sourced answer to the same candidate", async ({
  page,
}) => {
  await page.goto("/demo/map");
  const map = page.getByRole("region", { name: "議論のつながり" });
  const evidence = page.getByRole("complementary", { name: "根拠の発言" });
  const references = page.getByRole("region", { name: "参考資料" });
  const slider = page.getByRole("slider");
  const center = map.getByRole("group", {
    name: "「市民センターの研修室を使う」の確認事項",
  });
  const station = map.getByRole("group", {
    name: "「駅前の貸会議室を使う」の確認事項",
  });
  await expect(
    station.getByRole("button", { name: /AIに調べてもらう/ }),
  ).toHaveCount(0);
  const ask = center.getByRole("button", { name: /AIに調べてもらう/ });
  await ask.click();
  await expect(
    center.getByRole("button", { name: /AIが調査中/ }),
  ).toHaveAttribute("data-map-node", "n7");
  // The participants can keep talking before the answer is ready.
  await slider.press("ArrowRight");
  const result = map.getByRole("button", {
    name: /補強材料.*プロジェクター代を含む/,
  });
  await expect(result).toHaveAttribute("data-map-node", "n7");
  await expect(map.locator('[data-map-node="n3"]')).toHaveAttribute(
    "data-status",
    "candidate",
  );
  await result.click();
  await expect(
    evidence.getByText("昨年の土曜午後は6千円だった記憶。今年の料金は？"),
  ).toBeVisible();
  const source = evidence.getByRole("link", { name: /出典：市民センター/ });
  await expect(references.getByRole("link")).toHaveAttribute(
    "href",
    "/demo/map/sources#center",
  );
  const popup = page.waitForEvent("popup");
  await source.click();
  const document = await popup;
  await expect(document.locator("#center")).toContainText(
    "1区分6,000円。プロジェクターの利用料を含みます。",
  );
  await document.close();
  await slider.press("ArrowLeft");
  await slider.press("ArrowLeft");
  await expect(ask).toBeVisible();
  await expect(references).toHaveCount(0);
  await page.getByRole("button", { name: "AIに話す" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /市民センターの今年の料金/ })
    .click();
  await expect(result).toHaveAttribute("data-map-node", "n7");
  await expect(references.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "AIに話す" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: /市民センターの今年の料金/ }),
  ).toHaveCount(0);
});

test("a new spoken question starts under its candidate and a rewind discards the pending request", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo/map");
  const map = page.getByRole("region", { name: "議論のつながり" });
  const askByVoice = async () => {
    await page.getByRole("button", { name: "AIに話す" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /何時から入れる/ })
      .click();
  };
  await askByVoice();
  const newQuestion = map
    .getByRole("group", { name: "「市民センターの研修室を使う」の確認事項" })
    .getByRole("button", { name: /AIが調査中.*入室/ });
  await expect(newQuestion).toBeVisible();
  await page.getByRole("slider").press("ArrowLeft");
  await expect(map.locator('[data-map-node="center-entry-time"]')).toHaveCount(
    0,
  );
  await askByVoice();
  await expect(
    map.getByRole("button", { name: /確認結果.*午後1時から入室/ }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "参考資料" }).getByRole("listitem"),
  ).toHaveCount(1);
});

test("a guide without booking data leaves availability open until a participant confirms it", async ({
  page,
}) => {
  await page.goto("/demo/map");
  const slider = page.getByRole("slider");
  for (let turn = 16; turn < 24; turn++) await slider.press("ArrowRight");
  const map = page.getByRole("region", { name: "議論のつながり" });
  await map
    .getByRole("button", { name: /空いている.*AIに調べてもらう/ })
    .click();
  await expect(page.getByRole("region", { name: "参考資料" })).toContainText(
    "空きは確認できませんでした",
  );
  const availability = map.locator('[data-map-node="n8"]');
  await expect(availability).toHaveAttribute("data-status", "open");
  await slider.press("ArrowRight");
  await slider.press("ArrowRight");
  await expect(availability).toHaveAttribute("data-status", "confirmed");
  await expect(availability).toContainText("空きあり");
});
