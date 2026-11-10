import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { scoreMap } from "./map-classification/evaluate.mjs";

const fixtureDirectory = new URL(
  "../../../tests/fixtures/meetmap/",
  import.meta.url,
);
const scoringVersion = "source-kind-1";

// Export the actual changes to the reviewed synthetic demo so opening its URL
// needs neither a credential nor an inference call. Keep the source run traceable.
async function exportRecording(scriptId, turns, predictions, run, meta) {
  if (scriptId !== "venue-selection") throw new Error("different-demo");
  const script = await readFile(
    new URL("venue-selection.ja.jsonl", fixtureDirectory),
    "utf8",
  );
  const local = script
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const cloud = turns.map(({ id, speaker, text }) => ({ id, speaker, text }));
  if (!isDeepStrictEqual(local, cloud)) throw new Error("different-demo");
  let previous = { nodes: [], edges: [] };
  const steps = predictions.map(({ throughUtteranceId, graph }) => {
    const oldNodes = new Map(previous.nodes.map((node) => [node.id, node]));
    const oldEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
    const kept = new Set(graph.edges.map((edge) => edge.id));
    const step = {
      throughUtteranceId,
      nodes: graph.nodes.filter(
        (item) => !isDeepStrictEqual(oldNodes.get(item.id), item),
      ),
      edges: graph.edges.filter(
        (item) => !isDeepStrictEqual(oldEdges.get(item.id), item),
      ),
      removedEdgeIds: previous.edges
        .filter((edge) => !kept.has(edge.id))
        .map((edge) => edge.id),
    };
    previous = graph;
    return step;
  });
  const file = new URL(
    "../src/client/preview/map/venue-selection.vertex.json",
    import.meta.url,
  );
  const temp = new URL("." + randomUUID() + ".tmp", file);
  const { format } = await import("prettier");
  const json = await format(
    JSON.stringify({
      script: scriptId,
      run,
      model: meta.model,
      promptVersion: meta.promptVersion,
      steps,
    }),
    { parser: "json" },
  );
  await writeFile(temp, json, { flag: "wx" });
  await rename(temp, file);
}

async function main() {
  const {
    values: { project, script, run, "export-demo": publish },
  } = parseArgs({
    options: {
      project: { type: "string" },
      script: { type: "string", default: "venue-selection" },
      run: { type: "string" },
      "export-demo": { type: "boolean" },
    },
  });
  if (
    !project ||
    ![run, script].every(
      (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,75}$/.test(id),
    )
  )
    throw new Error("specify-project-and-run");
  const app = initializeApp({ projectId: project });
  const db = getFirestore(app);
  const scenario = db.doc("mapClassification/v1/scripts/" + script);
  const ref = scenario.collection("runs").doc(run);
  try {
    const [scenarioDoc, metaDoc, input, output, answers] = await Promise.all([
      scenario.get(),
      ref.get(),
      scenario.collection("turns").orderBy("position").get(),
      ref.collection("predictions").orderBy("position").get(),
      scenario.collection("expected").get(),
    ]);
    const meta = metaDoc.data();
    if (
      scenarioDoc.get("synthetic") !== true ||
      meta?.status !== "completed" ||
      !input.size ||
      ![meta.turnCount, meta.processedCount, output.size, answers.size].every(
        (n) => n === input.size,
      )
    )
      throw new Error("incomplete-run");
    const turns = input.docs.map((doc) => doc.data());
    const gold = new Map(answers.docs.map((doc) => [doc.id, doc.data()]));
    const predictions = output.docs.map((doc, i) => {
      const pred = doc.data(),
        turn = turns[i];
      if (
        !pred.graph ||
        pred.throughUtteranceId !== doc.id ||
        pred.position !== i + 1 ||
        doc.id !== turn.id ||
        gold.get(doc.id)?.throughUtteranceId !== turn.id
      )
        throw new Error("invalid-output");
      return pred;
    });
    const reports = predictions.map((pred) =>
      scoreMap(gold.get(pred.throughUtteranceId), pred.graph),
    );
    for (let start = 0; start < turns.length; start += 200) {
      const batch = db.batch();
      for (let i = start; i < Math.min(turns.length, start + 200); i++)
        batch.set(ref.collection("evaluations").doc(turns[i].id), {
          position: i + 1,
          throughUtteranceId: turns[i].id,
          scoringVersion,
          metrics: reports[i],
        });
      await batch.commit();
    }
    await ref.update({
      scoredCount: reports.length,
      scoringVersion,
      finalTurn: reports.at(-1),
      scoredAt: FieldValue.serverTimestamp(),
    });
    if (publish) await exportRecording(script, turns, predictions, run, meta);
    console.log(
      JSON.stringify({ compared: reports.length, finalTurn: reports.at(-1) }),
    );
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
}
main().catch((error) => {
  console.error(
    [
      "different-demo",
      "specify-project-and-run",
      "incomplete-run",
      "invalid-output",
    ].includes(error.message)
      ? error.message
      : "判定結果を照合できませんでした。",
  );
  process.exitCode = 1;
});
