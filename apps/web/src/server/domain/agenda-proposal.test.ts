import { expect, it } from "vitest";
import {
  evaluateProposal,
  readProposal,
  type Operation,
  type Proposal,
} from "./agenda-proposal";
import { initialAgenda } from "./meeting-agenda";

const agenda = { ...initialAgenda(30), planningAt: 0 };
const add: Operation = {
  action: "add",
  target: "part-0",
  name: "3万円以内の会場を比較",
  aim: "予算内の候補を絞る",
  minutes: 5,
};
const resize: Operation = { action: "resize", target: "part-1", minutes: 10 };
const proposal: Proposal = {
  id: "2495a326-91fe-4a3d-931e-4593f77fabd2",
  reason: "会場費の上限を反映",
  basePlanVersion: 0,
  operations: [add, resize],
};

it("validates the whole worker envelope before accepting a tool call", () => {
  const operations: Operation[] = [
    add,
    resize,
    { action: "rename", target: "legacy-8", name: "決定" },
    { action: "remove", target: "part-2" },
  ];
  expect(readProposal({ ...proposal, operations })).toEqual({
    ...proposal,
    operations,
  });
  for (const bad of [
    null,
    { ...proposal, id: "bad" },
    { ...proposal, basePlanVersion: -2 },
    { ...proposal, reason: " " },
    { ...proposal, operations: [] },
    { ...proposal, operations: Array(25).fill(add) },
  ])
    expect(readProposal(bad)).toBeNull();
  for (const bad of [
    null,
    { ...resize, target: "P1" },
    { ...resize, minutes: 2.5 },
    { ...resize, minutes: 0 },
    { ...add, aim: " " },
    { ...add, name: "A".repeat(41) },
    { ...add, action: "move" },
  ])
    expect(readProposal({ ...proposal, operations: [bad] })).toBeNull();
});

it("applies a time transfer as a unit and ties every operation to its original part", () => {
  const evaluate = (operations: Operation[], now = 0) =>
    evaluateProposal(agenda, { ...proposal, operations }, 30, now);
  const result = evaluate([
    add,
    resize,
    { action: "rename", target: "part-2", name: "選択" },
  ]);
  expect(result).toMatchObject({
    updated: {
      planVersion: 1,
      parts: [
        { partId: "part-0" },
        { partId: "part-4", minutes: 5, aim: add.aim },
        { partId: "part-1", minutes: 10 },
        { partId: "part-2", name: "選択" },
        { partId: "part-3", minutes: 2 },
      ],
    },
  });
  expect(evaluate([add])).toBe("over-total");
  expect(evaluate([resize, { action: "remove", target: "part-3" }])).toBe(
    "reflection-fixed",
  );
  expect(evaluate([{ action: "remove", target: "part-1" }, resize])).toBe(
    "unknown-part",
  );
  expect(evaluate([{ action: "resize", target: "part-0", minutes: 10 }])).toBe(
    "no-change",
  );
  expect(
    evaluate(
      agenda.parts
        .slice(0, -1)
        .map((p) => ({ action: "remove", target: p.partId })),
    ),
  ).toBe("discussion-required");
  expect(evaluate([add, resize], 13 * 60_000)).toBe("part-ended");
  expect(evaluate([{ action: "remove", target: "part-0" }], 180_000)).toBe(
    "current-part-moved",
  );
  expect(evaluate([resize], 33 * 60_000)).toBe("meeting-ended");
  expect(
    evaluateProposal({ ...agenda, planningAt: null }, proposal, 30, 0),
  ).toBe("not-planning");
  expect(evaluateProposal({ ...agenda, planVersion: 1 }, proposal, 30, 0)).toBe(
    "agenda-stale",
  );
  expect(agenda).toEqual({ ...initialAgenda(30), planningAt: 0 });
});
