import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scoreMap } from "./evaluate.mjs";
import { applyChange, classify, responseSchema } from "./vertex.mjs";

const definition = JSON.parse(
  readFileSync(
    new URL(
      "../../../../tests/fixtures/meetmap/classification.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const heard = [
  {
    id: "u01",
    speaker: "美咲",
    text: "駅前の貸会議室はどう？ 机を並べても12人全員座れるかな？",
  },
  { id: "u02", speaker: "陸", text: "机を並べて16席。12人なら全員座れるよ。" },
];
const empty = { nodes: [], edges: [] };
const link = { from: "u01_2", to: "u01_1", relation: "asks_about" };
const initial = applyChange(
  empty,
  {
    nodes: [
      { id: "u01_1", kind: "idea", text: "駅前の貸会議室を使う" },
      { id: "u01_2", kind: "question", text: "机を並べても12人全員が座れる？" },
    ],
    links: [link],
    unlink: [],
  },
  heard.slice(0, 1),
  definition,
);

test("a confirmed check updates the same card and replaces the pending link without changing the earlier turn", () => {
  const after = applyChange(
    initial,
    {
      nodes: [
        {
          id: "u01_2",
          kind: "question",
          status: "confirmed",
          text: "机を並べて16席あり、12人全員が座れる",
          role: "statement",
        },
      ],
      links: [{ ...link, relation: "supports" }],
      unlink: [],
    },
    heard,
    definition,
  );
  assert.equal(initial.edges[0].relation, "asks_about");
  assert.deepEqual(
    after.edges.map((e) => e.relation),
    ["supports"],
  );
  assert.deepEqual(after.nodes[1].sourceUtteranceIds, ["u01", "u02"]);
  assert.equal(after.nodes[1].sourceRoles.u02, "statement");
});

const project = process.env.MAP_CLASSIFICATION_TEST_PROJECT;
async function predict(heard, graph) {
  const { applicationDefault } = await import("firebase-admin/app");
  const prediction = await classify({
    credential: applicationDefault(),
    project,
    definition,
    heard,
    graph,
    schema: responseSchema(definition),
  });
  return prediction.graph;
}

for (const extra of ["", "それと、プロジェクターでスライドも映せるよ。"]) {
  test(
    extra
      ? "Vertex keeps a second independent fact from the same answer"
      : "Vertex uses the answered question itself as the supporting fact",
    { skip: !project },
    async () => {
      const graph = await predict(
        [heard[0], { ...heard[1], text: heard[1].text + extra }],
        initial,
      );
      const check = graph.nodes.find((n) => n.id === link.from);
      assert.equal(check?.status, "confirmed");
      const summary = check.text.normalize("NFKC");
      assert.match(summary, /(?:16|十六)\s*(?:席|人|名)/);
      assert.match(summary, /(?:12|十二)\s*(?:人|名)/);
      assert.match(summary, /机|テーブル/);
      assert.deepEqual(check.sourceUtteranceIds, ["u01", "u02"]);
      const evidence = graph.edges.filter((e) => e.to === link.to);
      assert.deepEqual(
        evidence.filter((e) => e.from === check.id).map((e) => e.relation),
        ["supports"],
      );
      const added = graph.nodes.filter(
        (n) => !initial.nodes.some((old) => old.id === n.id),
      );
      assert.equal(added.length, extra ? 1 : 0);
      if (extra) {
        assert.match(added[0].text, /プロジェクタ|スライド|投影/);
        assert.deepEqual(
          evidence.filter((e) => e.from === added[0].id).map((e) => e.relation),
          ["supports"],
        );
      }
    },
  );
}

test(
  "Vertex preserves the file limit and the actual size when a video exceeds the free plan",
  { skip: !project },
  async () => {
    const turns = [
      {
        id: "v01",
        speaker: "結衣",
        text: "説明会の動画を無料プランで公開したい。動画は120MBだけど、1ファイルで載せられるかな？",
      },
      {
        id: "v02",
        speaker: "海",
        text: "ヘルプの5ページ目で見つけたよ。無料プランで載せられるのは1ファイル100MBまでだって。",
      },
    ];
    const before = await predict(turns.slice(0, 1), empty);
    const question = before.nodes.find((n) => n.kind === "question");
    assert.ok(question, "the size check is open before the limit is known");
    const pending = before.edges.find(
      (e) => e.from === question.id && e.relation === "asks_about",
    );
    assert.ok(pending, "the question concerns the proposed plan");
    const after = await predict(turns, before);
    const answer = after.nodes.find((n) => n.id === question.id);
    assert.equal(answer?.status, "confirmed");
    assert.deepEqual(answer.sourceUtteranceIds, ["v01", "v02"]);
    const summary = answer.text.normalize("NFKC");
    assert.match(summary, /(?:120|百二十)\s*(?:MB|メガ)/i);
    assert.match(summary, /(?:100|百)\s*(?:MB|メガ)/i);
    assert.match(summary, /ファイル|動画[一1]本|[一1]本あたり/);
    assert.doesNotMatch(summary, /[五5]\s*ページ/);
    const opposing = after.edges.filter(
      (e) => e.to === pending.to && e.relation === "opposes",
    );
    assert.deepEqual(
      opposing.map((e) => e.from),
      [question.id],
    );
  },
);

test("a later card can cite an early source still on the map but outside the transcript window", () => {
  const after = applyChange(
    initial,
    {
      nodes: [
        {
          id: "u101_1",
          kind: "note",
          text: "最初の会場案を再検討",
          contextIds: ["u01"],
        },
      ],
      links: [{ from: "u101_1", to: "u01_1", relation: "informs" }],
      unlink: [],
    },
    [{ id: "u101", speaker: "陸", text: "最初の駅前案をもう一度検討しよう。" }],
    definition,
  );
  assert.deepEqual(after.nodes.at(-1).sourceUtteranceIds, ["u101", "u01"]);
});

test("rejects future citations and dangling endpoints before persisting", () => {
  assert.throws(
    () =>
      applyChange(
        initial,
        {
          nodes: [
            { id: "u02_1", kind: "note", text: "補足", contextIds: ["u03"] },
          ],
          links: [],
          unlink: [],
        },
        heard,
        definition,
      ),
    /heard turns/,
  );
  assert.throws(
    () =>
      applyChange(
        initial,
        { nodes: [], links: [{ ...link, to: "unknown" }], unlink: [] },
        heard,
        definition,
      ),
    /IDs present/,
  );
});

test("scoring tolerates independent IDs, counts duplicates and detects a reversed relation", () => {
  const nodes = initial.nodes.map((n) => ({ ...n, id: "model-" + n.id }));
  const graph = {
    nodes: [...nodes, { ...nodes[0], id: "duplicate" }],
    edges: [{ from: nodes[0].id, to: nodes[1].id, relation: "asks_about" }],
  };
  const report = scoreMap(initial, graph);
  assert.deepEqual(report.kinds, { matched: 2, expected: 2, predicted: 3 });
  assert.deepEqual(report.relations, { matched: 0, expected: 1, predicted: 1 });
});
