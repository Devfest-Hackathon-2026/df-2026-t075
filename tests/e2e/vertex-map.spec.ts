import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { MapRecording } from "../../apps/web/src/client/preview/map/vertex-replay";

const recording: MapRecording = JSON.parse(
  readFileSync(
    resolve("apps/web/src/client/preview/map/venue-selection.vertex.json"),
    "utf8",
  ),
);

test("the AI replay shows the recorded cards and compares the same turn with the reference", async ({
  page,
}) => {
  await page.goto("/demo/map/ai");
  const slider = page.getByRole("slider", { name: "台本の発言位置" });
  const ai = page.getByRole("button", { name: "AIの判定", exact: true });
  await expect(ai).toHaveAttribute("aria-pressed", "true");
  await expect(slider).toHaveValue(String(recording.steps.length));
  await slider.press("Home");
  const first = recording.steps[0]!;
  const chart = page.getByRole("region", { name: "議論のつながり" });
  for (const item of first.nodes)
    await expect(
      chart.locator(`[data-map-node="${item.id}"]`).first(),
    ).toContainText(item.text);
  const firstCard = chart
    .locator(`[data-map-node="${first.nodes[0]!.id}"]`)
    .first();
  await firstCard.click();
  await expect(
    page
      .getByRole("complementary", { name: "根拠の発言" })
      .locator("blockquote"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "正解例", exact: true }).click();
  await expect(slider).toHaveValue("1");
  await expect(firstCard).toHaveCount(0);
  await expect(chart.locator('[data-map-node="n1"]')).toBeVisible();
  await ai.click();
  await expect(firstCard).toBeVisible();
  await expect(page.getByRole("button", { name: "AIに話す" })).toHaveCount(0);
  await slider.press("End");
  await expect(slider).toHaveValue(String(recording.steps.length));
});
