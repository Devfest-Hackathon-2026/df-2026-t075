import {
  type DiscussionGraph,
  type EvidenceRelation,
  type MapNode,
  type MapResearch,
} from "../../discussion-map/types";

const station = {
  publisher: "駅前貸会議室",
  title: "2026年度 貸室案内",
  href: "/demo/map/sources#station",
};
const center = {
  publisher: "市民センター",
  title: "2026年度 研修室利用案内",
  href: "/demo/map/sources#center",
};

const accessId = "center-entry-time";
const accessQuestion = "市民センターの午後枠は何時から入室できる？";
type Example = {
  speech: string;
  answer: string;
  source: typeof center;
  // A document that doesn't establish the fact leaves the question open.
  relation?: EvidenceRelation;
};
const examples: Record<string, Example | undefined> = {
  n14: {
    speech: "駅前の会議室、机を並べても12人座れるか調べて",
    answer: "駅前は机を並べて16席。参加予定の12人が座れる",
    source: station,
    relation: "supports",
  },
  n15: {
    speech: "駅前の会議室、土曜の午後はいくらか調べて",
    answer: "駅前の土曜午後の室料は8,000円。機材代は別",
    source: station,
    relation: "informs",
  },
  n6: {
    speech: "駅前はプロジェクター込みで予算に収まるか調べて",
    answer: "駅前は室料8,000円＋機材3,000円で計11,000円。予算を1,000円超える",
    source: station,
    relation: "opposes",
  },
  n7: {
    speech: "市民センターの今年の料金、プロジェクター込みで調べて",
    answer: "市民センターの土曜午後は6,000円。プロジェクター代を含む",
    source: center,
    relation: "supports",
  },
  n8: {
    speech: "市民センター、12月12日の午後は空いているか調べて",
    answer:
      "利用案内には日付ごとの空き枠がなく、12月12日午後の空きは確認できませんでした。",
    source: center,
  },
  [accessId]: {
    speech: "市民センターって、午後は何時から入れるかも調べて",
    answer: "市民センターの研修室は午後1時から入室できる（午後枠は13〜17時）",
    source: center,
    relation: "informs",
  },
};

export type DemoRequest = {
  id: string;
  turn: number;
  question: string;
  done: boolean;
};

export function questionForRequest(graph: DiscussionGraph, id: string) {
  if (!examples[id]) return;
  const node = graph.nodes.find((item) => item.id === id);
  if (node)
    return node.status === "open" && !node.research ? node.text : undefined;
  if (id === accessId && graph.nodes.some((item) => item.id === "n3"))
    return accessQuestion;
}

export function voiceExamples(graph: DiscussionGraph) {
  return Object.entries(examples).flatMap(([id, example]) =>
    example && questionForRequest(graph, id)
      ? [{ id, speech: example.speech }]
      : [],
  );
}

// Put a simulated result on the original question. The replayed utterances
// and any decision on the candidate continue to come from the meeting script.
export function withDemoResearch(
  base: DiscussionGraph,
  requests: DemoRequest[],
): DiscussionGraph {
  if (!requests.length) return base;
  const nodes = new Map(base.nodes.map((node) => [node.id, node]));
  const edges = [...base.edges];
  for (const request of requests) {
    const example = examples[request.id];
    if (!example) continue;
    let node = nodes.get(request.id);
    if (!node && request.id === accessId && nodes.has("n3")) {
      node = {
        id: accessId,
        kind: "question",
        status: "open",
        text: accessQuestion,
        sourceUtteranceIds: [],
      };
      edges.push({
        id: "check-center-entry-time",
        from: node.id,
        to: "n3",
        relation: "asks_about",
      });
    }
    if (!node) continue;
    const research: MapResearch = request.done
      ? {
          question: request.question,
          state: example.relation ? "answered" : "unverified",
          answer: example.answer,
          source: example.source,
        }
      : { question: request.question, state: "looking" };
    const updated: MapNode = { ...node, research };
    if (
      research.state === "answered" &&
      example.relation &&
      node.status !== "confirmed"
    ) {
      updated.status = "confirmed";
      updated.text = research.answer;
      updated.reportedBy = "AI";
      const edgeIndex = edges.findIndex(
        (edge) => edge.from === request.id && edge.relation === "asks_about",
      );
      if (edgeIndex !== -1)
        edges[edgeIndex] = { ...edges[edgeIndex]!, relation: example.relation };
    } else if (research.state === "looking" && node.status === "open") {
      updated.status = "checking";
    }
    nodes.set(node.id, updated);
  }
  return { nodes: [...nodes.values()], edges };
}
