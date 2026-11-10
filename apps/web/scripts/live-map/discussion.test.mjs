import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { discussion } from "./discussion.mjs";
import { voiceGate, frameBytes } from "./audio.mjs";

test("two voices may transcribe out of order without changing speaker, turn order or graph context", async () => {
  const pending = [],
    predictions = [];
  const room = discussion(
    {
      recognize: () => new Promise((ok) => pending.push(ok)),
      predict: async (turns, graph) => {
        predictions.push([
          turns.map((t) => [t.id, t.speaker, t.text]),
          graph.nodes.length,
        ]);
        return { nodes: [...graph.nodes, { id: turns.at(-1).id }], edges: [] };
      },
    },
    () => {},
  );
  room.audio("葵", Buffer.from([1]));
  room.audio("陸", Buffer.from([2]));
  pending[1]("駅前を提案します");
  await setImmediate();
  assert.equal(room.snapshot().waiting, 2);
  assert.deepEqual(predictions, []);
  pending[0]("会場を決めよう");
  await setImmediate();
  const first = ["u01", "葵", "会場を決めよう"],
    second = ["u02", "陸", "駅前を提案します"];
  assert.deepEqual(predictions, [
    [[first], 0],
    [[first, second], 1],
  ]);
  assert.equal(room.snapshot().waiting, 0);
  room.end();
  assert.deepEqual(room.snapshot().turns, []);
});

test("text and speech keep extending the same map past 100 turns", async () => {
  let lastTranscript;
  const room = discussion(
    {
      recognize: async () => "音声の続き",
      predict: async (heard, graph) => {
        lastTranscript = heard;
        return {
          nodes: [...graph.nodes, { id: heard.at(-1).id }],
          edges: [],
        };
      },
    },
    () => {},
  );
  for (let n = 1; n <= 101; n++) {
    const accepted =
      n === 61
        ? room.audio("陸", Buffer.alloc(2))
        : room.text("葵", "発言" + n);
    assert.equal(accepted, true, "turn " + n);
    await setImmediate();
  }
  const { graph, turns, waiting } = room.snapshot();
  assert.equal(waiting, 0);
  assert.equal(turns.length, 101);
  assert.equal(turns[0].text, "発言1");
  assert.equal(turns[60].text, "音声の続き");
  assert.equal(turns[100].id, "u101");
  assert.ok(turns.every((t) => t.state === "mapped"));
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    turns.map((t) => t.id),
  );
  assert.deepEqual(
    lastTranscript.map((t) => t.id),
    turns.slice(-60).map((t) => t.id),
  );
});

test("a full backlog accepts new turns again after the map catches up", async () => {
  const gate = Promise.withResolvers();
  const room = discussion(
    {
      predict: async (_heard, graph) => {
        await gate.promise;
        return graph;
      },
    },
    () => {},
  );
  for (let i = 0; i < 12; i++) assert.equal(room.text("葵", "発言"), true);
  assert.equal(room.text("陸", "次の発言"), false);
  gate.resolve();
  await setImmediate();
  assert.equal(room.text("陸", "次の発言"), true);
  await setImmediate();
  assert.equal(room.snapshot().turns.at(-1).id, "u13");
  assert.equal(room.snapshot().waiting, 0);
});

test("a failed classification pauses the map, accepts further speech and retries the same turn", async () => {
  let calls = 0;
  const room = discussion(
    {
      predict: async (_turns, graph) => {
        if (!calls++) throw new Error();
        return graph;
      },
    },
    () => {},
  );
  room.text("葵", "どこで開く？");
  await setImmediate();
  room.text("陸", "駅前でどう？");
  await setImmediate();
  assert.deepEqual(
    room.snapshot().turns.map((t) => t.state),
    ["failed", "queued"],
  );
  room.recover("u01", false);
  await setImmediate();
  assert.equal(calls, 3);
  assert.equal(room.snapshot().waiting, 0);
});

test("ending an active room cancels and discards late recognitions", async () => {
  let finish,
    signal,
    calls = 0;
  const room = discussion(
    {
      recognize: (_bytes, s) => {
        signal = s;
        return new Promise((ok) => {
          finish = ok;
        });
      },
      predict: () => calls++,
    },
    () => {},
  );
  room.audio("葵", Buffer.from([1]));
  room.end();
  finish("案です");
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.equal(calls, 0);
  assert.deepEqual(room.snapshot().turns, []);
});

test("silence is free; a short pause stays in one utterance and muting flushes the last phrase", () => {
  const lengths = [],
    gate = voiceGate((b) => lengths.push(b.length / frameBytes)),
    loud = Buffer.alloc(frameBytes),
    quiet = Buffer.alloc(frameBytes);
  for (let i = 0; i < frameBytes; i += 2) loud.writeInt16LE(500, i);
  const push = (n, f) => {
    for (let i = 0; i < n; i++) gate.push(f);
  };
  push(20, quiet);
  push(4, loud);
  push(5, quiet);
  push(5, loud);
  push(13, quiet);
  push(2, loud);
  gate.finish();
  push(4, loud);
  gate.finish();
  assert.deepEqual(lengths, [19, 4]);
});
