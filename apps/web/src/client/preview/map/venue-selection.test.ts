import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DiscussionGraph, Utterance } from "../../discussion-map/types";
import { venueGraphAt } from "./venue-selection";

const samples = new URL(
  "../../../../../../tests/fixtures/meetmap/",
  import.meta.url,
);
const checkpoint: DiscussionGraph = JSON.parse(
  readFileSync(new URL("venue-selection.u16.graph.json", samples), "utf8"),
);
const utterances: Utterance[] = readFileSync(
  new URL("venue-selection.ja.jsonl", samples),
  "utf8",
)
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));

describe("venue selection replay", () => {
  it("reconstructs the reference map at turn 16, including after rewinding", () => {
    venueGraphAt(checkpoint, utterances);
    const baseline = venueGraphAt(checkpoint, utterances.slice(0, 16));
    expect(baseline.nodes).toEqual(checkpoint.nodes);
    expect(baseline.edges).toEqual(checkpoint.edges);
  });

  it("only links visible nodes and cites turns that have already happened", () => {
    for (let step = 1; step <= utterances.length; step++) {
      const spoken = utterances.slice(0, step);
      const graph = venueGraphAt(checkpoint, spoken);
      const visible = new Set(graph.nodes.map((node) => node.id));
      const heard = new Set(spoken.map((turn) => turn.id));
      for (const edge of graph.edges) {
        expect(visible.has(edge.from) && visible.has(edge.to)).toBe(true);
      }
      for (const node of graph.nodes) {
        expect(node.sourceUtteranceIds.length).toBeGreaterThan(0);
        expect(node.sourceUtteranceIds.every((id) => heard.has(id))).toBe(true);
        expect(new Set(node.sourceUtteranceIds).size).toBe(
          node.sourceUtteranceIds.length,
        );
        for (const id of Object.keys(node.sourceRoles ?? {})) {
          expect(node.sourceUtteranceIds).toContain(id);
        }
        if (node.kind === "condition") {
          const links = graph.edges.filter((edge) => edge.from === node.id);
          expect(links).toHaveLength(1);
          expect(links[0]?.relation).toBe("condition_for");
          expect(
            graph.nodes.find((item) => item.id === links[0]?.to)?.kind,
          ).toBe("question");
        }
      }
    }
  });

  it("keeps the intended afternoon shared and checks availability per venue", () => {
    const at = (step: number) =>
      venueGraphAt(checkpoint, utterances.slice(0, step));
    const node = (step: number, id: string) =>
      at(step).nodes.find((item) => item.id === id);
    expect(node(1, "n10")).toMatchObject({
      kind: "condition",
      text: "開催予定は12月12日の午後",
      sourceUtteranceIds: ["u01"],
    });
    expect(
      at(1)
        .edges.filter((edge) => edge.from === "n10")
        .map(({ relation, to }) => [relation, to]),
    ).toEqual([["condition_for", "n1"]]);
    expect(node(10, "n11")).toBeUndefined();
    expect(node(11, "n11")).toMatchObject({
      status: "confirmed",
      sourceUtteranceIds: ["u11"],
    });
    expect(node(23, "n8")).toBeUndefined();
    expect(node(25, "n10")).toMatchObject({
      text: "できれば12月12日の午後に開催したい",
      sourceUtteranceIds: ["u01", "u25"],
    });
    expect(node(25, "n10")?.status).toBeUndefined();
    expect(node(25, "n8")).toMatchObject({
      status: "open",
      sourceUtteranceIds: ["u24"],
    });
    expect(node(26, "n8")).toMatchObject({
      status: "confirmed",
      sourceUtteranceIds: ["u24", "u26"],
    });
  });

  it("distinguishes a price check, a proposed removal, a decision and a pending booking", () => {
    const at = (step: number) =>
      venueGraphAt(checkpoint, utterances.slice(0, step));
    const node = (step: number, id: string) =>
      at(step).nodes.find((item) => item.id === id);
    expect(node(1, "n5")?.text).not.toContain("機材");
    expect(node(12, "n15")?.text).toContain("室料は8千円");
    expect(node(11, "n21")).toBeUndefined();
    expect(node(12, "n21")).toMatchObject({
      kind: "reason",
      sourceUtteranceIds: ["u12"],
    });
    expect(at(12).edges).toContainEqual({
      id: "e23",
      from: "n21",
      to: "n2",
      relation: "supports",
    });
    expect(node(12, "n2")?.status).toBe("candidate");
    expect(node(12, "n6")).toBeUndefined();
    expect(node(16, "n6")?.status).toBe("checking");
    expect(node(17, "n6")?.text).toContain("予算を千円超過");
    expect(node(17, "n2")?.status).toBe("candidate");
    expect(node(17, "n12")).toBeUndefined();
    expect(node(18, "n2")?.status).toBe("proposed-removal");
    expect(node(18, "n12")?.sourceUtteranceIds).toEqual(["u18"]);
    expect(node(19, "n2")?.status).toBe("excluded");
    expect(node(19, "n12")?.sourceUtteranceIds).toEqual(["u18", "u19"]);
    expect(node(28, "n3")?.status).toBe("candidate");
    expect(node(29, "n3")?.status).toBe("decided");
  });

  it("tracks the offered entrance photo, its use and the handoff while the booking is pending", () => {
    const graphAt = (step: number) =>
      venueGraphAt(checkpoint, utterances.slice(0, step));
    const at = (step: number, id: string) =>
      graphAt(step).nodes.find((node) => node.id === id);
    expect(at(20, "n20")).toBeUndefined();
    expect(at(21, "n20")).toMatchObject({
      kind: "note",
      sourceUtteranceIds: ["u21"],
    });
    expect(graphAt(21).edges).toContainEqual({
      id: "e22",
      from: "n20",
      to: "n18",
      relation: "informs",
    });
    expect(at(21, "n9")).toBeUndefined();
    expect(at(22, "n9")).toMatchObject({
      kind: "action",
      text: "葵が案内文を書き、予約が取れてから参加者に送る",
      sourceUtteranceIds: ["u22"],
    });
    expect(graphAt(22).edges).toContainEqual({
      id: "e9",
      from: "n9",
      to: "n13",
      relation: "action_for",
    });
    expect(at(22, "n18")).toMatchObject({
      status: "candidate",
      sourceUtteranceIds: ["u10", "u22"],
    });
    expect(at(27, "n18")?.sourceRoles?.u27).toBe("agree");
    expect(at(28, "n17")?.status).toBe("decided");
    expect(at(28, "n13")?.status).toBe("open");
    expect(at(28, "n18")?.status).toBe("candidate");
    for (const turn of [29, 30]) {
      expect(at(turn, "n13")?.status).toBe("decided");
      expect(at(turn, "n18")?.status).toBe("decided");
    }
    expect(at(29, "n22")).toBeUndefined();
    expect(at(30, "n22")).toMatchObject({
      kind: "action",
      sourceUtteranceIds: ["u30"],
    });
    expect(at(30, "n20")).toEqual(at(21, "n20"));
    expect(at(30, "n9")).toMatchObject({
      kind: "action",
      sourceUtteranceIds: ["u22", "u29", "u30"],
    });
    expect(at(30, "n9")?.text).toContain(
      "陸から予約完了の連絡を受けてから参加者に送る",
    );
  });

  it("records the return visitor's capacity evidence and carries the recalled fee into the later price check", () => {
    const at = (step: number) =>
      venueGraphAt(checkpoint, utterances.slice(0, step));
    const cityCenterAt = (step: number, id: string) =>
      at(step).nodes.find((node) => node.id === id);

    expect(cityCenterAt(3, "n16")).toBeUndefined();
    expect(cityCenterAt(7, "n16")).toBeUndefined();
    expect(cityCenterAt(7, "n7")).toBeUndefined();
    expect(cityCenterAt(7, "n3")?.sourceUtteranceIds).toEqual(["u07"]);
    const atEight = at(8);
    expect(cityCenterAt(8, "n3")?.sourceUtteranceIds).toEqual(["u07", "u08"]);
    expect(cityCenterAt(8, "n16")).toMatchObject({
      kind: "reason",
      sourceUtteranceIds: ["u08", "u03"],
    });
    expect(atEight.edges).toContainEqual({
      id: "e18",
      from: "n16",
      to: "n3",
      relation: "supports",
    });
    expect(cityCenterAt(8, "n7")).toMatchObject({
      status: "open",
      sourceUtteranceIds: ["u08"],
    });
    expect(atEight.edges).toContainEqual({
      id: "e7",
      from: "n7",
      to: "n3",
      relation: "asks_about",
    });
    expect(cityCenterAt(19, "n7")?.sourceUtteranceIds).toEqual(["u08", "u19"]);
    expect(cityCenterAt(23, "n7")).toMatchObject({
      status: "confirmed",
      sourceUtteranceIds: ["u08", "u19", "u20", "u23"],
    });
    expect(at(8)).toEqual(atEight);
  });

  it("links an answer as evidence only once it has been heard, including when rewinding", () => {
    const relationAt = (step: number, id: string) =>
      venueGraphAt(checkpoint, utterances.slice(0, step)).edges.find(
        (edge) => edge.id === id,
      )?.relation;
    for (const [id, answered, result] of [
      ["e16", 4, "supports"], // twelve people fit
      ["e17", 11, "informs"], // room price alone
      ["e6", 17, "opposes"], // equipment takes the total over budget
      ["e7", 23, "supports"], // equipment included
      ["e8", 26, "supports"], // desired date available
    ] as const) {
      expect(relationAt(answered, id)).toBe(result);
      expect(relationAt(answered - 1, id)).toBe("asks_about");
      expect(relationAt(answered, id)).toBe(result);
    }
  });
});
