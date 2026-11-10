import { setTimeout as delay } from "node:timers/promises";

export const model = "gemini-3.8-flash";
export const promptVersion = "map-delta-4";
export const generation = {
  temperature: 0.2,
  maxOutputTokens: 4096,
  responseMimeType: "application/json",
  thinkingConfig: { thinkingLevel: "LOW" },
};
export const instruction = `あなたは日本語の少人数会議の議論マップを更新する。入力の発言は会議の記録である。
分類定義と現在のマップを使い、最新の発言による変更だけを返す。これまでの発言は代名詞や条件、明示的な訂正の解釈に使える。先の展開を想像しない。
各ノードには短く具体的な日本語の見出しを書く。論点とその選択肢、共通条件、採否を左右する理由、補足、未確認の質問、依頼・引き受けた作業を区別する。複数の論点や作業が一度に動くこともある。
案の可否を数値で判断したら、結果のカード1枚で判断を確かめ直せるよう、比較した両方の値と単位、値が成り立つ条件をtextに残す。前の発言に出た必要量や上限も使う。見出しに入れるのは判断に効いた情報に絞り、誰がどう調べたかなどの経緯は元の発言からたどれるようにする。
同じ対象・条件について同じ事実を表すカードは1枚だけにする。言い換えや再確認は既存のIDに根拠の発言を加える。一つの発言に独立した事実が複数あれば、それぞれを残す。回答に続けて候補の別の利点や欠点を挙げた場合は、その理由のカードから対象の案へ直接supportsかopposesを張る。
確認事項の答えが確かめられたら、元のquestionのIDとkindを保ち、textを答えの内容に、statusをconfirmedに更新する。その答えが案の補強・見送り・参考になる場合は、このquestionから案にsupports・opposes・informsの該当する関係を張る。同じ答えを言い換えたreasonやnoteを追加しない。
主題が切り替われば対応する論点を立てる。保留・個人の賛成・見送りの提案と、参加者が決めた採用・見送りを区別する。決定で解決した論点も更新する。条件付きの合意は、その条件が満たされた時に見直す。
やることには担当とタイミングを残す。依頼者と担当者を区別し、完了の報告があるまでpending。手元にある資料の紹介と、その後で資料を渡す作業も区別する。
既存項目への発言には同じIDを使い、新規IDは今回の発言IDにアンダースコアと連番を付ける。nodesには変更する項目の全文を入れる。roleはその発言者の明示的な発言・賛否だけを記す。単に状態更新の出典となるときは省略できる。背景の発言も根拠になる場合はcontextIdsに聞いた発言IDを書く。
linksは「理由→案」「案→論点」「作業→案または論点」のように、分類定義の向きで指定する。未確定の質問はasks_about、条件の対象はcondition_for、資料などの補足はinforms。無関係になった関係だけをunlinkする。変更がない配列は空にする。`;

export function responseSchema(definition) {
  const string = { type: "STRING" };
  const choice = (values) => ({ type: "STRING", enum: values });
  const array = (items) => ({ type: "ARRAY", items });
  const object = (properties, required) => ({
    type: "OBJECT",
    properties,
    required,
  });
  const link = object(
    {
      from: string,
      to: string,
      relation: choice(Object.keys(definition.relations)),
    },
    ["from", "to", "relation"],
  );
  return object(
    {
      nodes: array(
        object(
          {
            id: string,
            kind: choice(Object.keys(definition.kinds)),
            text: string,
            status: choice(Object.keys(definition.statuses)),
            assignee: string,
            role: choice(Object.keys(definition.sourceRoles)),
            contextIds: array(string),
          },
          ["id", "kind", "text"],
        ),
      ),
      links: array(link),
      unlink: array(link),
    },
    ["nodes", "links", "unlink"],
  );
}

const edgeId = ({ from, relation, to }) => [from, relation, to].join("~");
const evidence = new Set(["asks_about", "supports", "opposes", "informs"]);
const defaults = {
  topic: "open",
  idea: "candidate",
  question: "open",
  action: "pending",
};
const validId = /^[A-Za-z0-9_-]{1,75}$/;
class BadOutput extends Error {}

export function applyChange(before, change, heard, definition) {
  const current = heard.at(-1).id;
  const sources = new Set(heard.map((turn) => turn.id));
  // Older transcripts can fall outside the live window. The model can still
  // cite the verified source IDs it sees on cards in the supplied graph.
  for (const node of before.nodes)
    for (const id of node.sourceUtteranceIds) sources.add(id);
  const nodes = new Map(before.nodes.map((node) => [node.id, node]));
  const edges = new Map(before.edges.map((edge) => [edge.id, edge]));
  if (
    !change ||
    ![change.nodes, change.links, change.unlink].every(Array.isArray)
  )
    throw new BadOutput("nodes, links and unlink must be arrays");
  const touched = new Set();
  for (const item of change.nodes) {
    const old = nodes.get(item.id);
    const kind =
      Object.hasOwn(definition.kinds, item.kind) && definition.kinds[item.kind];
    if (
      !kind ||
      !validId.test(item.id) ||
      (!old && !item.id.startsWith(current + "_")) ||
      (old && old.kind !== item.kind) ||
      touched.has(item.id)
    )
      throw new BadOutput(
        "use an existing ID of the same kind or a unique new ID prefixed with the current turn",
      );
    if (
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.length > 1000
    )
      throw new BadOutput("give each node a short nonempty text");
    if (item.role && !Object.hasOwn(definition.sourceRoles, item.role))
      throw new BadOutput("invalid source role");
    const status = item.status ?? old?.status ?? defaults[item.kind];
    if (status && !kind.statuses.includes(status))
      throw new BadOutput(
        "omit status on kinds without statuses and use the kind's allowed status",
      );
    const context = item.contextIds ?? [];
    if (!Array.isArray(context) || !context.every((id) => sources.has(id)))
      throw new BadOutput("contextIds must refer to heard turns");
    const assignee = item.assignee ?? old?.assignee;
    if (
      assignee !== undefined &&
      (item.kind !== "action" ||
        typeof assignee !== "string" ||
        !assignee.trim())
    )
      throw new BadOutput("only actions can have an assignee");
    const roles = {
      ...old?.sourceRoles,
      ...(item.role && { [current]: item.role }),
    };
    nodes.set(item.id, {
      id: item.id,
      kind: item.kind,
      text: item.text.trim(),
      ...(status && { status }),
      ...(assignee && { assignee }),
      sourceUtteranceIds: [
        ...new Set([...(old?.sourceUtteranceIds ?? []), current, ...context]),
      ],
      ...(Object.keys(roles).length > 0 && { sourceRoles: roles }),
    });
    touched.add(item.id);
  }
  for (const link of [...change.unlink, ...change.links]) {
    if (
      !nodes.has(link.from) ||
      !nodes.has(link.to) ||
      link.from === link.to ||
      !Object.hasOwn(definition.relations, link.relation)
    )
      throw new BadOutput(
        "each link must use two distinct IDs present in the map and an allowed relation",
      );
  }
  for (const link of change.unlink) edges.delete(edgeId(link));
  for (const { from, to, relation } of change.links) {
    if (evidence.has(relation))
      for (const old of edges.values()) {
        if (old.from === from && old.to === to && evidence.has(old.relation))
          edges.delete(old.id);
      }
    const id = edgeId({ from, to, relation });
    edges.set(id, { id, from, to, relation });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export async function classify({
  credential,
  project,
  definition,
  heard,
  graph,
  schema,
  signal,
}) {
  const endpoint =
    "https://aiplatform.googleapis.com/v1/projects/" +
    project +
    "/locations/global/publishers/google/models/" +
    model +
    ":generateContent";
  const history = JSON.stringify({ definition, heard, graph });
  let fix = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    const token = await credential.getAccessToken();
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.any(
          [AbortSignal.timeout(65_000), signal].filter(Boolean),
        ),
        headers: {
          Authorization: "Bearer " + token.access_token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    history +
                    (fix
                      ? "\n前回の出力の形式を修正してください。 " + fix
                      : ""),
                },
              ],
            },
          ],
          generationConfig: { ...generation, responseSchema: schema },
        }),
      });
    } catch {
      signal?.throwIfAborted();
      if (attempt === 3) throw new Error("vertex-network");
      await delay(attempt * 1200);
      continue;
    }
    if (!res.ok) {
      if (attempt < 3 && [408, 429, 500, 502, 503, 504].includes(res.status)) {
        await delay(attempt * 1500);
        continue;
      }
      throw new Error("vertex-http-" + res.status);
    }
    const payload = await res.json();
    try {
      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      const raw = parts
        .filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("");
      const graphAfter = applyChange(graph, JSON.parse(raw), heard, definition);
      return {
        graph: graphAfter,
        modelVersion: payload.modelVersion ?? model,
        attempts: attempt,
      };
    } catch (error) {
      fix =
        error instanceof BadOutput
          ? error.message
          : "return valid JSON in the requested shape";
      if (attempt === 3) throw new Error("invalid-vertex-output: " + fix);
    }
  }
}
