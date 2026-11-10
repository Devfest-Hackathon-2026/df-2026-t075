import { expect, it } from "vitest";
import { mapLayout } from "./columns";
import type { DiscussionGraph, MapEdge, MapNode } from "./types";

const node = (id: string, kind: MapNode["kind"]): MapNode => ({
  id,
  kind,
  text: id,
  sourceUtteranceIds: [],
});
const edge = (
  from: string,
  to: string,
  relation: MapEdge["relation"],
): MapEdge => ({ id: from + "-" + to, from, to, relation });

it("places the topic and conditions before candidates and follows supporting links across as many columns as needed", () => {
  const nodes = [
    node("date", "condition"),
    node("why", "reason"),
    node("venue", "idea"),
    node("topic", "question"),
    node("source", "reason"),
    { ...node("available", "question"), status: "confirmed" as const },
    node("budget", "condition"),
    node("other", "idea"),
  ];
  const edges = [
    edge("date", "topic", "condition_for"),
    edge("budget", "topic", "condition_for"),
    edge("venue", "topic", "answers"),
    edge("available", "venue", "supports"),
    edge("why", "venue", "supports"),
    edge("source", "why", "supports"),
  ];
  expect(
    mapLayout({ nodes, edges }).columns.map(([level, group]) => [
      level,
      group.map((item) => item.id),
    ]),
  ).toEqual([
    [0, ["topic", "date", "budget"]],
    [1, ["venue", "other"]],
    [2, ["why", "available"]],
    [3, ["source"]],
  ]);
});

it("keeps each candidate with its own branch, including deep and shared evidence", () => {
  const nodes = [
    node("topic", "question"),
    node("a", "idea"),
    node("b", "idea"),
    node("for-b", "reason"),
    node("shared", "reason"),
    node("detail", "reason"),
    node("for-a", "reason"),
  ];
  const edges = [
    edge("a", "topic", "answers"),
    edge("b", "topic", "answers"),
    edge("shared", "b", "opposes"),
    edge("shared", "a", "supports"),
    edge("for-b", "b", "supports"),
    edge("detail", "for-a", "supports"),
    edge("for-a", "a", "supports"),
  ];
  const layout = mapLayout({ nodes, edges });
  const { bands } = layout.rows[0]!;
  const ids = (column: number, row: number) =>
    bands.cells
      .get(column)
      ?.get(row)
      ?.map(({ id }) => id);
  expect(bands.count).toBe(2);
  expect(ids(2, 1)).toEqual(["shared", "for-a"]);
  expect(ids(3, 1)).toEqual(["detail"]);
  expect(ids(2, 2)).toEqual(["for-b"]);
  expect(layout.edges).toContainEqual(edge("shared", "b", "opposes"));
});

it("nests unanswered checks under their candidates without drawing graph edges", () => {
  const check = { ...node("fee", "question"), status: "checking" as const };
  const graph = {
    nodes: [
      node("a", "idea"),
      node("b", "idea"),
      check,
      node("topic", "question"),
    ],
    edges: [edge("fee", "a", "asks_about"), edge("a", "topic", "answers")],
  };
  const layout = mapLayout(graph);
  expect(layout.pendingByIdea.get("a")).toEqual([check]);
  expect(layout.pendingByIdea.has("b")).toBe(false);
  expect(layout.columns.flatMap(([, lane]) => lane)).not.toContain(check);
  expect(layout.edges).toEqual([edge("a", "topic", "answers")]);
});

it("places actions beyond even the deepest reason, level with their owners and without connecting lines", () => {
  const nodes = [
    node("common", "action"),
    node("book", "action"),
    node("send", "action"),
    node("topic", "question"),
    node("a", "idea"),
    node("b", "idea"),
    node("why", "reason"),
    node("detail", "reason"),
  ];
  const reasoning = [
    edge("a", "topic", "answers"),
    edge("b", "topic", "answers"),
    edge("why", "a", "supports"),
    edge("detail", "why", "supports"),
  ];
  const layout = mapLayout({
    nodes,
    edges: [
      ...reasoning,
      edge("common", "topic", "action_for"),
      edge("book", "b", "action_for"),
      edge("send", "a", "action_for"),
    ],
  });
  expect(layout.edges).toEqual(reasoning);
  const { bands } = layout.rows[0]!;
  const [lastLevel, tasks] = layout.columns.at(-1)!;
  expect(lastLevel).toBe(4);
  expect(tasks.map((item) => item.kind)).toEqual([
    "action",
    "action",
    "action",
  ]);
  expect(
    bands.cells
      .get(lastLevel)
      ?.get(1)
      ?.map((item) => item.id),
  ).toEqual(["send", "common"]);
  expect(
    bands.cells
      .get(lastLevel)
      ?.get(2)
      ?.map((item) => item.id),
  ).toEqual(["book"]);
  expect([...bands.topicActions]).toEqual(["common"]);
});

it("retains both nodes of a circular reference and renders disconnected nodes", () => {
  const nodes = [
    node("a", "reason"),
    node("b", "reason"),
    node("topic", "question"),
  ];
  const edges = [edge("a", "b", "supports"), edge("b", "a", "supports")];
  const visible = mapLayout({ nodes, edges }).columns.flatMap(([, group]) =>
    group.map((item) => item.id),
  );
  expect(visible.sort()).toEqual(["a", "b", "topic"]);
});

it("keeps the reason for changing a condition beside that condition and leaves the preferred idea in the candidate lane", () => {
  const graph: DiscussionGraph = {
    nodes: [
      node("venue", "idea"),
      node("directions", "question"),
      node("meeting", "question"),
      {
        ...node("budget", "condition"),
        text: "予算の上限を1万1千円に変更",
        status: "relaxed",
      },
      { ...node("access", "reason"), text: "駅前案の通いやすさを優先" },
      node("booking", "condition"),
    ],
    edges: [
      edge("venue", "meeting", "answers"),
      edge("budget", "meeting", "condition_for"),
      edge("booking", "directions", "condition_for"),
      edge("access", "budget", "revises_condition"),
      edge("access", "venue", "cites"),
    ],
  };
  const layout = mapLayout(graph);
  expect(layout.columns.map(([, lane]) => lane.map(({ id }) => id))).toEqual([
    ["directions", "booking", "meeting", "budget", "access"],
    ["venue"],
  ]);
  expect(layout.edges).toEqual([edge("venue", "meeting", "answers")]);
});
