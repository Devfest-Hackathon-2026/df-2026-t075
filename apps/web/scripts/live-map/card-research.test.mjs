import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { cardResearch, roomResearchBudget } from "./card-research.mjs";
import { searchPages, sourcedAnswer } from "./search-web.mjs";

const question = {
  id: "q",
  kind: "question",
  status: "open",
  text: "入館料は？",
};
const idea = { id: "i", kind: "idea", status: "candidate", text: "未来館" };
const graph = {
  nodes: [question, idea, { id: "private", kind: "note", text: "別の話題" }],
  edges: [{ id: "qi", from: "q", to: "i", relation: "asks_about" }],
};
const answer = {
  state: "answered",
  answer: "一般入館料は630円。",
  relation: "informs",
  source: {
    title: "利用案内",
    publisher: "未来館",
    href: "https://www.miraikan.jst.go.jp/visit/",
  },
};
const at = (tracker, base = graph) => tracker.graph(base).nodes[0];

test("both entrances share one search; the original map keeps human decisions and other cards", async () => {
  const calls = [];
  const budget = roomResearchBudget();
  const tracker = cardResearch(
    (card) => {
      calls.push(card);
      return answer;
    },
    () => {},
    budget,
  );
  tracker.request(graph, "q");
  tracker.request(graph, "q");
  assert.equal(at(tracker).status, "checking");
  await setImmediate();
  assert.deepEqual(calls, [
    {
      kind: "question",
      question: "入館料は？",
      candidates: ["未来館"],
      topics: [],
      conditions: [],
    },
  ]);
  assert.equal(budget.remaining, 11);
  assert.equal(at(tracker).id, "q");
  assert.equal(at(tracker).text, answer.answer);
  assert.deepEqual(at(tracker).research.source, answer.source);
  assert.equal(tracker.graph(graph).edges[0].relation, "informs");
  assert.equal(graph.nodes[0].status, "open");
  assert.equal(tracker.graph(graph).nodes[1], idea);
  const human = {
    ...graph,
    nodes: [
      { ...question, status: "confirmed", text: "窓口にも確認した" },
      idea,
    ],
  };
  tracker.reconcile(human);
  assert.equal(at(tracker, human).text, "窓口にも確認した");
  assert.deepEqual(at(tracker, human).research.source, answer.source);
  assert.equal(at(tracker, human).reportedBy, undefined);
});

test("an unavailable lookup stays open and concurrent retries consume one additional attempt", async () => {
  let n = 0;
  const tracker = cardResearch(
    () => {
      if (!n++) throw new Error("private upstream response");
      return {
        state: "unverified",
        answer: "公開資料では確認できませんでした。",
      };
    },
    () => {},
    { remaining: 2 },
  );
  tracker.request(graph, "q");
  await setImmediate();
  const failed = at(tracker).research;
  assert.equal(failed.state, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /private upstream/);
  assert.equal(at(tracker).status, "open");
  tracker.request(graph, "q", failed.retryId);
  tracker.request(graph, "q", failed.retryId);
  await setImmediate();
  assert.equal(n, 2);
  assert.equal(at(tracker).research.state, "unverified");
  assert.equal(at(tracker).status, "open");
  assert.equal(
    tracker.request(graph, "q", at(tracker).research.retryId),
    "research-limit",
  );
});

test("a new subject, human ownership and closing a map invalidate in-flight findings", async () => {
  for (const event of ["new-subject", "human", "end"]) {
    let done, observedSignal;
    const tracker = cardResearch(
      (_card, signal) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          done = resolve;
        });
      },
      () => {},
      roomResearchBudget(),
    );
    tracker.request(graph, "q");
    await setImmediate();
    const next = {
      ...graph,
      nodes:
        event === "new-subject"
          ? [question, { ...idea, text: "国立科学博物館" }]
          : [{ ...question, status: "checking" }, idea],
    };
    if (event === "end") tracker.end();
    else tracker.reconcile(next);
    assert.ok(observedSignal.aborted);
    done(answer);
    await setImmediate();
    assert.equal(at(tracker, next).research, undefined);
    assert.equal(tracker.request(next, "missing"), "research-stale");
    if (event === "human")
      assert.equal(tracker.request(next, "q"), "research-stale");
  }
});

test("only a retrieved HTTPS source with a matching passage can confirm a question", () => {
  const pages = searchPages([
    {
      type: "text",
      text: "Title: 不正\nURL: https://localhost/x\nHighlights:\nlocal\n\n---\n\nTitle: 利用案内\nURL: https://www.miraikan.jst.go.jp/visit/\nHighlights:\n一般の入館料は６３０円です。",
    },
  ]);
  assert.equal(pages.length, 1);
  const matching = {
    sourceNumber: 1,
    quote: "入館料は630円です",
    answer: "一般は630円。",
    relation: "informs",
  };
  assert.equal(sourcedAnswer(matching, pages).source.href, pages[0].href);
  for (const bad of [
    { sourceNumber: 0 },
    { sourceNumber: 9 },
    { quote: "無料で利用できます" },
    { quote: "。" },
  ])
    assert.equal(
      sourcedAnswer({ ...matching, ...bad }, pages).state,
      "unverified",
    );
});
