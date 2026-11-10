import { readFile } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { venueGraphAt } from "../src/client/preview/map/venue-selection.ts";

const fixtures = new URL("../../../tests/fixtures/meetmap/", import.meta.url);
const version = "mapClassification/v1";
const scenario = version + "/scripts/venue-selection";
// The reviewed demo represents both topics and checks as question cards.
const venueTopicIds = new Set(["n1", "n13"]);

class DatasetError extends Error {}

async function loadDataset() {
  const [definitionFile, scriptFile, checkpointFile] = await Promise.all(
    [
      "classification.v1.json",
      "venue-selection.ja.jsonl",
      "venue-selection.u16.graph.json",
    ].map((name) => readFile(new URL(name, fixtures), "utf8")),
  );
  const definition = JSON.parse(definitionFile);
  const turns = scriptFile
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const checkpoint = JSON.parse(checkpointFile);
  const documents = new Map([
    [version, definition],
    [
      scenario,
      {
        title: "ゼミの勉強会の会場選び",
        language: "ja",
        synthetic: true,
        turnCount: turns.length,
      },
    ],
  ]);
  const heard = [];
  for (const turn of turns) {
    heard.push(turn);
    const { nodes, edges } = venueGraphAt(checkpoint, heard);
    const classified = nodes.map((node) => {
      if (venueTopicIds.has(node.id)) return { ...node, kind: "topic" };
      if (node.kind === "action") return { status: "pending", ...node };
      return node;
    });
    for (const node of classified) {
      const kind = definition.kinds[node.kind];
      if (!kind || (node.status && !kind.statuses.includes(node.status)))
        throw new DatasetError(
          "正解例の分類または状態が v1 の定義と一致しません。",
        );
    }
    if (
      edges.some((edge) => !Object.hasOwn(definition.relations, edge.relation))
    )
      throw new DatasetError("正解例の関係が v1 の定義と一致しません。");
    documents.set(scenario + "/turns/" + turn.id, {
      ...turn,
      position: heard.length,
    });
    documents.set(scenario + "/expected/" + turn.id, {
      throughUtteranceId: turn.id,
      nodes: classified,
      edges,
    });
  }
  return documents;
}

function compareStored(snapshot, expected) {
  if (!isDeepStrictEqual(snapshot.data(), expected)) {
    throw new DatasetError(
      "保存済みのデータが正解例と一致しません: " + snapshot.ref.path,
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: { project: { type: "string" }, check: { type: "boolean" } },
  });
  if (!values.project)
    throw new DatasetError(
      "--project で対象の Firebase プロジェクトを指定してください。",
    );
  const documents = await loadDataset();
  const app = initializeApp({ projectId: values.project });
  const db = getFirestore(app);
  try {
    const refs = [...documents.keys()].map((path) => db.doc(path));
    let created = 0;
    if (!values.check) {
      created = await db.runTransaction(async (tx) => {
        const snapshots = await tx.getAll(...refs);
        let count = 0;
        for (const snapshot of snapshots) {
          const expected = documents.get(snapshot.ref.path);
          if (snapshot.exists) compareStored(snapshot, expected);
          else {
            tx.create(snapshot.ref, expected);
            count++;
          }
        }
        return count;
      });
    }
    for (const snapshot of await db.getAll(...refs)) {
      compareStored(snapshot, documents.get(snapshot.ref.path));
    }
    console.log(
      `判別用データを ${created} 件作成し、${documents.size} 件を読み戻して照合しました。`,
    );
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
}

main().catch((error) => {
  // SDK errors can contain request details. Only emit a known message or a code.
  console.error(
    error instanceof DatasetError
      ? error.message
      : `判別用DBの処理に失敗しました（${Number.isInteger(error.code) ? error.code : "設定・接続を確認"}）。`,
  );
  process.exitCode = 1;
});
