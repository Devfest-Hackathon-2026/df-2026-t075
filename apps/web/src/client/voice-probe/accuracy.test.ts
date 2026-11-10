import { expect, it } from "vitest";
import { characterErrors } from "./accuracy";

it("scores Japanese text by Unicode character, ignoring punctuation, spacing, and width", () => {
  expect(characterErrors("ＡＩは１５分。", "AI は15分！")).toEqual({
    edits: 0,
    characters: 6,
  });
  expect(characterErrors("Ａ＋Ｂ～。\u200b", "a+b")).toEqual({
    edits: 1,
    characters: 4,
  });
  expect(characterErrors("声を聞く", "声をよく聴く")).toEqual({
    edits: 3,
    characters: 4,
  });
  expect(characterErrors("話します", "")).toEqual({ edits: 4, characters: 4 });
  expect(characterErrors("語", "語学学")).toEqual({ edits: 2, characters: 1 });
  expect(characterErrors("　。", "話します")).toBeNull();
});
