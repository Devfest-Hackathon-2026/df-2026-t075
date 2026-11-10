import { expect, test, type Locator } from "@playwright/test";

function mapBounds(view: Locator) {
  return view.evaluate((el) => {
    const frame = el.getBoundingClientRect();
    const cards = Array.from(el.querySelectorAll(".map-node"), (card) =>
      card.getBoundingClientRect(),
    );
    return {
      left: Math.min(...cards.map((card) => card.left)) - frame.left,
      right:
        frame.left +
        el.clientWidth -
        Math.max(...cards.map((card) => card.right)),
      top: Math.min(...cards.map((card) => card.top)) - frame.top,
      bottom:
        frame.top +
        el.clientHeight -
        Math.max(...cards.map((card) => card.bottom)),
      x: el.scrollLeft,
      y: el.scrollTop,
      width: el.scrollWidth,
      height: el.scrollHeight,
      maxX: el.scrollWidth - el.clientWidth,
      maxY: el.scrollHeight - el.clientHeight,
    };
  });
}

async function expectWholeMap(view: Locator) {
  await expect
    .poll(async () => {
      const { left, right, top, bottom, maxX, maxY, x, y } =
        await mapBounds(view);
      return (
        Math.min(left, right, top, bottom) >= -1 &&
        Math.max(maxX, maxY, x, y) <= 1
      );
    })
    .toBe(true);
}

test("the overview fits every card on first load, replay, and resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/demo/map");
  const view = page.getByRole("region", { name: "マップの表示範囲" });
  const slider = page.getByRole("slider");
  const left = view.getByRole("group", { name: "論点・条件" });
  const date = left.getByRole("button", { name: /開催予定は12月12日の午後/ });
  await expect(date).toContainText("条件");
  const topic = left.getByRole("button", { name: /勉強会をどこで開く/ });
  const idea = view.getByRole("button", { name: /駅前の貸会議室を使う/ });
  const reason = view.getByRole("button", { name: /改札から近く/ });
  const x = (card: Locator) =>
    card.evaluate((el) => el.getBoundingClientRect().left);
  expect(await x(date)).toBe(await x(topic));
  expect(await x(idea)).toBeGreaterThan(await x(date));
  expect(await x(reason)).toBeGreaterThan(await x(idea));
  await expectWholeMap(view);
  const hasLines = () =>
    page.locator("canvas.map-lines").evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, i) => i % 4 === 3 && value > 0);
    });
  await expect.poll(hasLines).toBe(true);
  for (let turn = 16; turn > 13; turn--) await slider.press("ArrowLeft");
  await expect(slider).toHaveValue("13");
  await expectWholeMap(view);
  await page.setViewportSize({ width: 390, height: 700 });
  await expectWholeMap(view);
  await slider.press("End");
  await expectWholeMap(view);
  await slider.press("Home");
  await expectWholeMap(view);
  // Only the topic, date, and budget exist in the first turn.
  await expect(left.getByRole("button")).toHaveCount(3);
  await expect.poll(hasLines).toBe(false);
  await expect(page.getByRole("button", { name: "原寸で読む" })).toHaveCount(0);
});

test("directions get their own row and gain the map and photo proposals on their respective turns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/demo/map");
  const slider = page.getByRole("slider");
  for (let turn = 16; turn > 8; turn--) await slider.press("ArrowLeft");
  const chart = page.getByRole("region", { name: "マップの表示範囲" });
  const meeting = chart.getByRole("group", {
    name: "勉強会をどこで開く？",
    exact: true,
  });
  const directions = chart.getByRole("group", {
    name: "参加者にどう道案内する？",
    exact: true,
  });
  const map = directions.getByRole("button", {
    name: /案内に地図のリンクを貼る/,
  });
  const photo = directions.getByRole("button", {
    name: /入口の写真も案内に添える/,
  });
  const evidence = page.getByRole("complementary", { name: "根拠の発言" });
  await expect(directions).toHaveCount(0);
  await slider.press("ArrowRight");
  await expect(map).toContainText("候補");
  await expect(map.locator(".map-speaker")).toHaveText(["美咲"]);
  await expect(photo).toHaveCount(0);
  const previous = (await meeting.boundingBox())!;
  const topic = (await directions
    .getByRole("button", { name: /参加者にどう道案内する/ })
    .boundingBox())!;
  expect(topic.y - previous.y - previous.height).toBeGreaterThan(32);
  expect(Math.abs((await map.boundingBox())!.y - topic.y)).toBeLessThan(1);
  await expect(
    evidence.getByRole("button", { name: /この論点への案.*地図のリンク/ }),
  ).toBeVisible();

  await slider.press("ArrowRight");
  await expect(map.locator(".map-node-reactions")).toHaveText("👍葵");
  await expect(photo).toContainText("候補");
  await photo.click();
  await evidence
    .getByRole("button", { name: /案を支える理由.*反対側/ })
    .click();
  await expect(evidence.locator("blockquote")).toContainText(
    "できれば入口の写真も",
  );
  await slider.press("ArrowLeft");
  await expect(photo).toHaveCount(0);
  await expect(map.locator(".map-node-reactions")).toHaveCount(0);
});

test("the directions map distinguishes the offered photo from the work people take on", async ({
  page,
}) => {
  await page.goto("/demo/map");
  const slider = page.getByRole("slider");
  const directions = page.getByRole("group", {
    name: "参加者にどう道案内する？",
    exact: true,
  });
  const evidence = page.getByRole("complementary", { name: "根拠の発言" });
  const note = directions.getByRole("button", {
    name: /補足.*曲がり角が写った.*入口写真/,
  });
  const writing = directions.getByRole("button", {
    name: /やること.*葵が案内文を書き/,
  });
  for (let turn = 16; turn < 20; turn++) await slider.press("ArrowRight");
  await expect(note).toHaveCount(0);
  await slider.press("ArrowRight");
  await expect(note).toHaveAttribute("aria-pressed", "true");
  await expect(note.locator(".map-speaker")).toHaveText("美咲");
  await expect(evidence.locator("blockquote")).toContainText(
    "入口の写真を持ってるよ",
  );
  await expect(writing).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "やること", exact: true }),
  ).toHaveCount(0);

  await slider.press("ArrowRight");
  await expect(writing).toHaveAttribute("aria-pressed", "true");
  await expect(writing).toContainText("論点全体");
  await expect(writing).toContainText("予約が取れてから参加者に送る");
  await expect(writing.locator(".map-speaker")).toHaveText("葵");
  await expect(evidence.locator("blockquote")).toContainText(
    "案内文は私が書くね",
  );
  await expect(
    directions
      .getByRole("group", { name: "論点・条件" })
      .getByText(/案内文を書き/),
  ).toHaveCount(0);

  await slider.press("End");
  const handoff = directions.getByRole("button", {
    name: /やること.*入口写真を葵に送る/,
  });
  await expect(handoff).toHaveAttribute("aria-pressed", "true");
  const photo = directions.getByRole("button", {
    name: /案内には美咲の入口写真を添える/,
  });
  const topic = directions.getByRole("button", {
    name: /参加者にどう道案内する/,
  });
  await expect(topic).toContainText("検討終了");
  await expect(photo).toContainText("決定");
  const handoffBox = (await handoff.boundingBox())!;
  const noteBox = (await note.boundingBox())!;
  expect(handoffBox.x).toBeGreaterThan(noteBox.x + noteBox.width);
  expect(Math.abs(handoffBox.y - (await photo.boundingBox())!.y)).toBeLessThan(
    1,
  );
  await expect(evidence.locator("blockquote")).toContainText(
    "私は入口の写真を葵に送るね",
  );
  await expect(note).toBeVisible();
  await slider.press("ArrowLeft");
  await expect(handoff).toHaveCount(0);
  await expect(writing).toContainText("陸から予約完了の連絡を受けてから");
  await expect(topic).toContainText("検討終了");
  await expect(photo).toContainText("決定");
  await slider.press("ArrowLeft");
  await expect(topic).toContainText("検討中");
  await expect(photo).toContainText("候補");
});

test("turn 29 assigns the booking to Riku beside the city center proposal and preserves Aoi's request", async ({
  page,
}) => {
  await page.goto("/demo/map");
  const slider = page.getByRole("slider");
  const view = page.getByRole("region", { name: "マップの表示範囲" });
  const venues = view.getByRole("group", {
    name: "勉強会をどこで開く？",
    exact: true,
  });
  const center = venues.getByRole("button", {
    name: /市民センターの研修室を使う/,
  });
  const booking = venues
    .getByRole("group", { name: "やること", exact: true })
    .getByRole("button", { name: /市民センターの研修室を予約/ });
  const quote = page.getByRole("complementary", { name: "根拠の発言" });
  await slider.press("End");
  await slider.press("ArrowLeft");
  await slider.press("ArrowLeft");
  await expect(slider).toHaveValue("28");
  await expect(booking).toHaveCount(0);
  await slider.press("ArrowRight");
  await expect(booking).toHaveAttribute("aria-pressed", "true");
  await expect(booking).toHaveAccessibleName(/担当\s*陸.*発言\s*葵/);
  await expect(booking).toContainText("取れたらみんなに知らせる");
  await expect(quote.locator(".map-speaker")).toHaveText("葵");
  await expect(quote.locator("blockquote")).toContainText("陸、申込みお願い");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await expectWholeMap(view);
    const box = (await booking.boundingBox())!;
    const reasons = venues
      .getByRole("group", { name: /^理由・確認結果/ })
      .getByRole("button");
    const right = await reasons.evaluateAll((cards) =>
      Math.max(...cards.map((card) => card.getBoundingClientRect().right)),
    );
    expect(box.x).toBeGreaterThan(right);
    expect(Math.abs(box.y - (await center.boundingBox())!.y)).toBeLessThan(1);
  }
  await quote
    .getByRole("button", { name: /この作業の対象.*市民センターの研修室を使う/ })
    .click();
  await expect(center).toHaveAttribute("aria-pressed", "true");
  await slider.press("ArrowRight");
  await expect(booking).toBeVisible();
});

test("reading at full size scrolls only as far as the outer cards and returns to the overview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 650 });
  await page.goto("/demo/map");
  const view = page.getByRole("region", { name: "マップの表示範囲" });
  await page.getByRole("slider").press("End");
  await expectWholeMap(view);
  await page.getByRole("button", { name: "原寸で読む" }).click();
  await view.evaluate((el) => el.scrollTo(0, 0));
  const start = await mapBounds(view);
  expect(start.maxX).toBeGreaterThan(0);
  expect(start.maxY).toBeGreaterThan(0);
  expect(start.left).toBeLessThanOrEqual(20);
  expect(start.top).toBeLessThanOrEqual(60);
  await view.hover();
  await page.mouse.wheel(80, 70);
  await expect.poll(async () => (await mapBounds(view)).x).toBeGreaterThan(0);
  await expect.poll(async () => (await mapBounds(view)).y).toBeGreaterThan(0);
  for (let n = 0; n < 3; n++) {
    await view.evaluate(async (el) => {
      el.scrollTo(el.scrollWidth + 1000, el.scrollHeight + 1000);
      await new Promise(requestAnimationFrame);
    });
  }
  const end = await mapBounds(view);
  expect(end.x).toBe(start.maxX);
  expect(end.y).toBe(start.maxY);
  expect(end.right).toBeGreaterThanOrEqual(0);
  expect(end.right).toBeLessThanOrEqual(24);
  expect(end.bottom).toBeGreaterThanOrEqual(0);
  expect(end.bottom).toBeLessThanOrEqual(26);
  await view.evaluate((el) => el.scrollTo(-1000, -1000));
  expect(await mapBounds(view)).toEqual(start);
  await page.getByRole("button", { name: "全体を表示" }).click();
  await expectWholeMap(view);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

test("the next candidate starts below the previous candidate's last reason as the discussion changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/demo/map");
  const slider = page.getByRole("slider");
  const view = page.getByRole("region", { name: "マップの表示範囲" });
  const center = view.getByRole("button", {
    name: /市民センターの研修室を使う/,
  });
  const centerReason = view.getByRole("button", { name: /研修室は20人収容/ });
  const stationDetails = view.locator("[data-map-node]").filter({
    hasText:
      /改札から近く|駅前の貸会議室は12月12日|机を並べても16席|駅前の12日午後の室料|補強材料.*プロジェクターでスライド|プロジェクター代は含まれる|予算を千円超過/,
  });
  const hasClearance = async () => {
    await expect(stationDetails).toHaveCount(6);
    const bottom = await stationDetails.evaluateAll((nodes) =>
      Math.max(...nodes.map((node) => node.getBoundingClientRect().bottom)),
    );
    const next = (await center.boundingBox())!;
    const firstReason = (await centerReason.boundingBox())!;
    expect(next.y).toBeGreaterThan(bottom + 1);
    expect(Math.abs(next.y - firstReason.y)).toBeLessThan(1);
  };
  for (let turn = 16; turn > 13; turn--) await slider.press("ArrowLeft");
  await expect(slider).toHaveValue("13");
  await hasClearance();
  await page.setViewportSize({ width: 390, height: 780 });
  await expectWholeMap(view);
  await hasClearance();
  await page.getByRole("button", { name: "原寸で読む" }).click();
  for (let turn = 13; turn < 17; turn++) await slider.press("ArrowRight");
  await expect(slider).toHaveValue("17");
  await hasClearance();
});

test("the public map replays the room decision and shows the selected idea's source turns", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "議論マップを試す" }).click();
  await expect(page).toHaveURL(/\/demo\/map$/);
  const chart = page.getByRole("region", { name: "議論のつながり" });
  const evidence = page.getByRole("complementary", { name: "根拠の発言" });
  const position = page.getByRole("slider", { name: "台本の発言位置" });
  await expect(position).toHaveValue("16");
  const venue = chart.getByRole("button", { name: /駅前の貸会議室を使う/ });
  await venue.click();
  await expect(evidence.getByText(/駅前はまだ候補にしといて/)).toBeVisible();
  await expect(evidence.locator("blockquote")).toHaveCount(3);
  await page.getByRole("button", { name: "次の発言" }).click();
  await expect(
    chart.getByRole("button", { name: /確認済み.*予算を千円超過/ }),
  ).toBeVisible();
  await expect(
    evidence.getByText(/駅前はプロジェクターを使うとプラス3千円/),
  ).toBeVisible();
  await page.getByRole("button", { name: "前の発言" }).click();
  await expect(
    chart.getByRole("button", { name: /確認中.*プロジェクター代/ }),
  ).toBeVisible();
  await expect(chart.getByText(/予算を千円超過/)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await venue.click();
  await expect(
    evidence.getByRole("heading", { name: "根拠の発言" }),
  ).toBeFocused();
  await evidence.getByRole("button", { name: "マップに戻る" }).click();
  await expect(venue).toBeFocused();
  await position.focus();
  await position.press("End");
  await expect(page.getByRole("button", { name: "次の発言" })).toBeDisabled();
  await expect(
    chart.getByRole("button", { name: /決定.*市民センターの研修室を使う/ }),
  ).toBeVisible();
  await position.press("Home");
  await expect(page.getByRole("button", { name: "前の発言" })).toBeDisabled();
  await expect(venue).toHaveCount(0);
  await page.getByRole("link", { name: "ホームへ" }).click();
  await expect(
    page.getByRole("link", { name: "会議デモを試す" }),
  ).toHaveAttribute("href", "/home");
});

test("speaker names and colors follow the cited turns when stepping or rewinding", async ({
  page,
}) => {
  await page.goto("/demo/map");
  const chart = page.getByRole("region", { name: "議論のつながり" });
  const evidence = page.getByRole("complementary", { name: "根拠の発言" });
  const player = page.getByRole("region", { name: "会話台本の再生" });
  const slider = page.getByRole("slider");
  const date = chart.getByRole("button", { name: /開催予定は12月12日の午後/ });
  await expect(date).toContainText("条件");
  await expect(date.locator(".map-speaker")).toHaveText(["葵"]);
  await date.click();
  await expect(evidence.locator("blockquote")).toContainText("12月12日の午後");
  await expect(
    evidence.getByRole("button", {
      name: /この条件が属する論点.*勉強会をどこで開く/,
    }),
  ).toBeVisible();
  await expect(
    evidence.getByRole("button", { name: /貸会議室を使う|研修室を使う/ }),
  ).toHaveCount(0);
  const color = (badge: Locator) =>
    badge.evaluate((element) => getComputedStyle(element).backgroundColor);
  const aoi = await color(player.getByText("葵", { exact: true }));
  expect(await color(date.getByText("葵", { exact: true }))).toBe(aoi);
  expect(await color(evidence.getByText("葵", { exact: true }))).toBe(aoi);

  const station = chart.getByRole("button", { name: /駅前の貸会議室を使う/ });
  await expect(station.locator(".map-speaker")).toHaveText(["陸"]);
  await expect(station.locator(".map-node-reactions")).toHaveCount(0);
  const price = chart.getByRole("button", {
    name: /駅前の室料8千円にプロジェクター代/,
  });
  await expect(price.locator(".map-speaker")).toHaveText(["葵"]);
  await station.click();
  await expect(evidence.locator(".map-speaker")).toHaveText(["陸", "陸", "葵"]);
  const riku = await color(station.getByText("陸", { exact: true }));
  expect(await color(evidence.getByText("陸", { exact: true }).first())).toBe(
    riku,
  );
  await player.getByRole("button", { name: "次の発言" }).click();
  const misaki = await color(player.getByText("美咲", { exact: true }));
  expect(new Set([aoi, riku, misaki]).size).toBe(3);
  expect(await color(evidence.getByText("美咲", { exact: true }).last())).toBe(
    misaki,
  );
  await expect(
    chart
      .getByRole("button", { name: /予算を千円超過/ })
      .locator(".map-speaker"),
  ).toHaveText(["美咲"]);

  await slider.press("Home");
  await expect(chart.getByText("陸", { exact: true })).toHaveCount(0);
  await expect(chart.getByText("美咲", { exact: true })).toHaveCount(0);
  await slider.press("ArrowRight");
  await expect(station.locator(".map-speaker")).toHaveText(["陸"]);
  expect(await color(player.getByText("陸", { exact: true }))).toBe(riku);
});

test("shows the proposer above the idea and the reactions heard so far below it", async ({
  page,
}) => {
  await page.goto("/demo/map");
  const chart = page.getByRole("region", { name: "議論のつながり" });
  const slider = page.getByRole("slider");
  const station = chart.getByRole("button", { name: /駅前の貸会議室を使う/ });
  const center = chart.getByRole("button", {
    name: /市民センターの研修室を使う/,
  });
  const objections = station.locator(".map-node-reactions");
  const agreements = center.locator(".map-node-reactions");
  const reason = chart.getByRole("button", {
    name: /見送りの理由.*上限を千円超える/,
  });
  const evidence = page.getByRole("complementary", { name: "根拠の発言" });

  await slider.press("ArrowRight"); // 17: the price report is context.
  await expect(objections).toHaveCount(0);
  await expect(reason).toHaveCount(0);
  await slider.press("ArrowRight"); // 18: the proposer now objects to using the venue.
  await expect(reason).toBeVisible();
  await expect(station.locator(".map-node-meta .map-speaker")).toHaveText([
    "陸",
  ]);
  await expect(objections).toHaveText("👎陸");
  await slider.press("ArrowRight");
  await expect(objections).toHaveText("👎陸葵");
  await expect(agreements).toHaveCount(0);
  await station.click();
  await evidence.getByRole("button", { name: /見送りの理由/ }).click();
  await expect(evidence.getByText(/今回は駅前は外そう/)).toBeVisible();
  await expect(
    evidence.getByRole("button", { name: /判断の根拠.*室料8千円/ }),
  ).toBeVisible();
  await evidence.getByRole("button", { name: /判断の根拠.*1万円以内/ }).click();
  await expect(
    evidence.getByRole("button", {
      name: /この条件が属する論点.*勉強会をどこで開く/,
    }),
  ).toBeVisible();

  await slider.press("End");
  await expect(center.locator(".map-node-meta .map-speaker")).toHaveText([
    "葵",
  ]);
  await expect(agreements).toHaveText("👍美咲陸");
  await center.click();
  await expect(evidence.getByText(/私はセンターに賛成/)).toBeVisible();
  await expect(evidence.getByText(/僕もセンターがいい/)).toBeVisible();
  for (let step = 30; step > 27; step--) await slider.press("ArrowLeft");
  await expect(agreements).toHaveText("👍美咲");
  await slider.press("ArrowLeft");
  await expect(agreements).toHaveCount(0);
  await slider.press("ArrowRight");
  await expect(agreements).toHaveText("👍美咲");
});

test("an unanswered check sits directly below its candidate and moves right on confirmation", async ({
  page,
}) => {
  await page.goto("/demo/map");
  const view = page.getByRole("region", { name: "マップの表示範囲" });
  const results = view.getByRole("group", { name: "理由・確認結果" });
  const pending = view.getByRole("group", {
    name: "「駅前の貸会議室を使う」の確認事項",
  });
  const question = pending.getByRole("button", {
    name: /確認中.*プロジェクター代/,
  });
  const station = view.getByRole("button", {
    name: /候補.*駅前の貸会議室を使う/,
  });
  await expect(question).toBeVisible();
  await expect(results.getByText(/プロジェクター代は含まれる/)).toHaveCount(0);
  const card = (await station.boundingBox())!;
  const note = (await question.boundingBox())!;
  expect(note.y).toBeGreaterThanOrEqual(card.y + card.height - 1);
  expect(note.y - card.y - card.height).toBeLessThan(12);
  expect(note.x).toBeGreaterThanOrEqual(card.x);
  expect(note.x + note.width).toBeLessThanOrEqual(card.x + card.width + 1);
  await question.click();
  const evidence = page.getByRole("complementary", { name: "根拠の発言" });
  await expect(evidence.getByText(/備品の料金表も見てみる/)).toBeVisible();
  const slider = page.getByRole("slider");
  await slider.press("ArrowRight");
  await expect(pending).toHaveCount(0);
  const against = results.getByRole("button", {
    name: /見送り材料.*予算を千円超過/,
  });
  await expect(against).toBeVisible();
  await expect(station).toBeVisible();
  await against.click();
  await expect(evidence.getByText(/プラス3千円/)).toBeVisible();
  await slider.press("ArrowLeft");
  await expect(question).toBeVisible();
  await expect(against).toHaveCount(0);

  const center = view.getByRole("group", {
    name: "「市民センターの研修室を使う」の確認事項",
  });
  for (let turn = 16; turn < 22; turn++) await slider.press("ArrowRight");
  await expect(
    center.getByRole("button", { name: /確認中.*機材代/ }),
  ).toBeVisible();
  await slider.press("ArrowRight");
  await expect(center).toHaveCount(0);
  await expect(
    results.getByRole("button", { name: /補強材料.*機材込みで6千円/ }),
  ).toBeVisible();
});

test("turn eight attributes city center capacity to Riku and keeps this year's fee open", async ({
  page,
}) => {
  await page.goto("/demo/map");
  const slider = page.getByRole("slider", { name: "台本の発言位置" });
  await slider.press("Home");
  for (let turn = 1; turn < 7; turn++) await slider.press("ArrowRight");

  const chart = page.getByRole("region", { name: "マップの表示範囲" });
  const results = chart.getByRole("group", { name: "理由・確認結果" });
  const candidate = chart.getByRole("button", {
    name: /市民センターの研修室を使う/,
  });
  const capacity = results.getByRole("button", {
    name: /補強材料.*20人収容.*12人/,
  });
  const fee = chart
    .getByRole("group", { name: "「市民センターの研修室を使う」の確認事項" })
    .getByRole("button", { name: /未確認.*昨年.*6千円/ });
  const evidence = page.getByRole("complementary", { name: "根拠の発言" });
  const recollection = evidence
    .locator("blockquote")
    .filter({ hasText: "そこ、去年借りたよ" });
  await expect(capacity).toHaveCount(0);
  await expect(fee).toHaveCount(0);
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("8");
  await expect(candidate).toHaveAttribute("aria-pressed", "true");
  await expect(candidate.locator(".map-speaker")).toHaveText(["葵"]);
  await expect(recollection).toBeVisible();
  await expect(capacity.locator(".map-speaker")).toHaveText(["陸"]);
  await expect(capacity).not.toContainText("確認済み");
  await expect(fee).toBeVisible();
  await capacity.click();
  await expect(recollection).toBeVisible();
  await expect(evidence.getByText(/今のところ来るのは12人/)).toBeVisible();
  await expect(
    evidence.getByRole("button", { name: /この理由が支える案.*市民センター/ }),
  ).toBeVisible();
  await fee.click();
  await expect(recollection).toBeVisible();
  await slider.press("ArrowLeft");
  await expect(capacity).toHaveCount(0);
  await expect(fee).toHaveCount(0);
  await expect(recollection).toHaveCount(0);
});
