import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  classify,
  generation,
  instruction,
  model,
  promptVersion,
  responseSchema,
} from "./map-classification/vertex.mjs";

function stableJson(value) {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}
const leaseEnd = (snap) =>
  Timestamp.fromMillis(snap.readTime.toMillis() + 300_000);
const release = { owner: FieldValue.delete(), leaseUntil: FieldValue.delete() };

async function main() {
  const {
    values: { project, script, run },
  } = parseArgs({
    options: {
      project: { type: "string" },
      script: { type: "string", default: "venue-selection" },
      run: { type: "string" },
    },
  });
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? "") ||
    ![script, run].every(
      (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,75}$/.test(id),
    )
  )
    throw new Error("specify-project-and-run");
  const credential = applicationDefault();
  const app = initializeApp({ credential, projectId: project });
  const db = getFirestore(app);
  const catalog = db.doc("mapClassification/v1");
  const scenario = catalog.collection("scripts").doc(script);
  const result = scenario.collection("runs").doc(run);
  const owner = randomUUID();
  let active = false;
  try {
    const [catalogDoc, scriptDoc, inputs] = await Promise.all([
      catalog.get(),
      scenario.get(),
      scenario.collection("turns").orderBy("position").get(),
    ]);
    if (
      !catalogDoc.exists ||
      scriptDoc.get("synthetic") !== true ||
      !inputs.size ||
      inputs.size !== scriptDoc.get("turnCount")
    )
      throw new Error("invalid-synthetic-script");
    const definition = JSON.parse(stableJson(catalogDoc.data()));
    const turns = inputs.docs.map((doc, i) => {
      const { id, position, speaker, text } = doc.data();
      if (
        doc.id !== id ||
        !/^[A-Za-z0-9_-]{1,60}$/.test(id) ||
        position !== i + 1 ||
        !speaker ||
        !text
      )
        throw new Error("invalid-turns");
      return { id, position, speaker, text };
    });
    const schema = responseSchema(definition);
    const signature = createHash("sha256")
      .update(
        stableJson({
          definition,
          turns,
          model,
          instruction,
          generation,
          schema,
          promptVersion,
        }),
      )
      .digest("hex");
    const progress = await db.runTransaction(async (tx) => {
      const snap = await tx.get(result);
      const lock = {
        status: "classifying",
        owner,
        leaseUntil: leaseEnd(snap),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!snap.exists) {
        tx.create(result, {
          ...lock,
          signature,
          script,
          model,
          promptVersion,
          definitionVersion: definition.version,
          turnCount: turns.length,
          processedCount: 0,
          createdAt: FieldValue.serverTimestamp(),
        });
        return 0;
      }
      if (snap.get("signature") !== signature)
        throw new Error("different-run-inputs");
      if (snap.get("status") === "completed") return turns.length;
      if (snap.get("leaseUntil")?.toMillis() > snap.readTime.toMillis())
        throw new Error("run-in-use");
      tx.update(result, lock);
      return snap.get("processedCount");
    });
    if (progress === turns.length) {
      console.log("判定済み " + progress + "/" + turns.length);
      return;
    }
    active = true;
    let graph =
      progress === 0
        ? { nodes: [], edges: [] }
        : (
            await result
              .collection("predictions")
              .doc(turns[progress - 1].id)
              .get()
          ).get("graph");
    for (let i = progress; i < turns.length; i++) {
      const turn = turns[i];
      const prediction = await classify({
        credential,
        project,
        definition,
        heard: turns.slice(0, i + 1),
        graph,
        schema,
      });
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(result);
        if (snap.get("owner") !== owner || snap.get("processedCount") !== i)
          throw new Error("run-ownership-changed");
        tx.create(result.collection("predictions").doc(turn.id), {
          ...prediction,
          position: turn.position,
          throughUtteranceId: turn.id,
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.update(result, {
          processedCount: i + 1,
          updatedAt: FieldValue.serverTimestamp(),
          ...(i + 1 === turns.length
            ? {
                status: "completed",
                ...release,
                completedAt: FieldValue.serverTimestamp(),
              }
            : { leaseUntil: leaseEnd(snap) }),
        });
      });
      graph = prediction.graph;
      console.log("判定を保存 " + (i + 1) + "/" + turns.length);
    }
    active = false;
  } finally {
    try {
      if (active)
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(result);
          if (snap.get("owner") === owner)
            tx.update(result, {
              status: "interrupted",
              ...release,
              updatedAt: FieldValue.serverTimestamp(),
            });
        });
    } finally {
      await db.terminate();
      await deleteApp(app);
    }
  }
}

main().catch((error) => {
  // Only report known codes, never a provider payload or a conversation.
  console.error(
    /^(?:vertex-http-\d+|vertex-network|invalid-vertex-output: [A-Za-z0-9, '\-]+|specify-project-and-run|invalid-(?:synthetic-script|turns)|different-run-inputs|run-in-use|run-ownership-changed)$/.test(
      error.message,
    )
      ? error.message
      : "判定を中断しました。" +
          (Number.isInteger(error.code) ? " Firestore " + error.code : ""),
  );
  process.exitCode = 1;
});
