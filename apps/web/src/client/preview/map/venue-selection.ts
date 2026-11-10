import {
  isEvidenceRelation,
  type DiscussionGraph,
  type MapEdge,
  type MapNode,
  type MapReaction,
  type Utterance,
} from "../../discussion-map/types.ts";

// These later turns extend the reference map. A proposal and an agreed decision
// are separate turns, as are deciding the venue and actually booking it.
const laterNodes: MapNode[] = [
  {
    id: "n12",
    kind: "reason",
    text: "予算の上限を千円超えるため、今回は駅前を外す",
    sourceUtteranceIds: ["u18", "u19"],
  },
  {
    id: "n8",
    kind: "question",
    text: "市民センターは12月12日の午後に空いている？",
    status: "open",
    sourceUtteranceIds: ["u24"],
  },
  {
    id: "n20",
    kind: "note",
    text: "美咲は、バス停側の曲がり角が写った市民センターの入口写真を持っている",
    sourceUtteranceIds: ["u21"],
  },
  {
    id: "n9",
    kind: "action",
    assignee: "葵",
    text: "葵が案内文を書き、予約が取れてから参加者に送る",
    sourceUtteranceIds: ["u22"],
  },
  {
    id: "n22",
    kind: "action",
    assignee: "美咲",
    text: "美咲が市民センターの入口写真を葵に送る",
    sourceUtteranceIds: ["u30"],
  },
  {
    id: "n23",
    kind: "action",
    assignee: "陸",
    text: "陸が市民センターの研修室を予約し、取れたらみんなに知らせる",
    sourceUtteranceIds: ["u29"],
  },
];

const laterEdges: MapEdge[] = [
  { id: "e8", from: "n8", to: "n3", relation: "asks_about" },
  { id: "e9", from: "n9", to: "n13", relation: "action_for" },
  { id: "e13", from: "n12", to: "n2", relation: "reason_for_exclusion" },
  { id: "e14", from: "n12", to: "n5", relation: "cites" },
  { id: "e15", from: "n12", to: "n6", relation: "cites" },
  { id: "e22", from: "n20", to: "n18", relation: "informs" },
  { id: "e24", from: "n22", to: "n18", relation: "action_for" },
  { id: "e25", from: "n23", to: "n3", relation: "action_for" },
];

// The checkpoint still has open checks. Each answer has a specific bearing
// on its own candidate; the candidate's decision is a separate later turn.
const confirmedRelations = new Map<string, "supports" | "opposes">([
  ["e6", "opposes"],
  ["e7", "supports"],
  ["e8", "supports"],
]);

type Revision = Pick<MapNode, "id"> &
  Partial<Pick<MapNode, "text" | "status">> & { reaction?: MapReaction };

const revisions: Record<string, Revision[]> = {
  u17: [
    {
      id: "n6",
      status: "confirmed",
      text: "室料8千円＋機材3千円で計1万1千円。予算を千円超過",
    },
  ],
  u18: [{ id: "n2", status: "proposed-removal", reaction: "disagree" }],
  u19: [
    { id: "n2", status: "excluded", reaction: "disagree" },
    { id: "n7", text: "市民センターの6千円に機材代は含まれる？" },
  ],
  u20: [{ id: "n7", status: "checking" }],
  u21: [{ id: "n13" }],
  u22: [
    { id: "n13" },
    { id: "n18", text: "市民センターの案内には美咲の入口写真を添える" },
  ],
  u23: [
    { id: "n7", text: "市民センターは機材込みで6千円", status: "confirmed" },
  ],
  u25: [{ id: "n10", text: "できれば12月12日の午後に開催したい" }],
  u26: [
    {
      id: "n8",
      text: "市民センターは12月12日の午後に空きあり",
      status: "confirmed",
    },
  ],
  u27: [
    { id: "n3", reaction: "agree" },
    { id: "n13" },
    { id: "n18", reaction: "agree" },
  ],
  u28: [{ id: "n3", reaction: "agree" }],
  u29: [
    { id: "n3", status: "decided" },
    { id: "n1", status: "decided" },
    // Choosing the center settles the directions already agreed for that venue.
    { id: "n13", status: "decided" },
    { id: "n18", status: "decided" },
    {
      id: "n9",
      text: "葵が案内文を書き、陸から予約完了の連絡を受けてから参加者に送る",
    },
  ],
  u30: [{ id: "n13" }, { id: "n18" }, { id: "n9" }],
};

export function venueGraphAt(
  checkpoint: DiscussionGraph,
  spoken: Utterance[],
): DiscussionGraph {
  const heard = new Set(spoken.map((utterance) => utterance.id));
  const nodes = new Map<string, MapNode>();
  for (const node of [...checkpoint.nodes, ...laterNodes]) {
    // An earlier citation (such as the headcount) doesn't introduce this item.
    const [introducedBy] = node.sourceUtteranceIds;
    if (!introducedBy || !heard.has(introducedBy)) continue;
    // u11 gives the room price. Its inclusion of equipment is first asked at u13.
    if (node.id === "n6" && !heard.has("u13")) continue;
    const sourceUtteranceIds = node.sourceUtteranceIds.filter((id) =>
      heard.has(id),
    );
    const visible = { ...node, sourceUtteranceIds };
    if (node.sourceRoles) {
      visible.sourceRoles = Object.fromEntries(
        Object.entries(node.sourceRoles).filter(([id]) => heard.has(id)),
      );
    }
    if (node.id === "n5" && !heard.has("u16"))
      visible.text = "ゼミ費の上限は1万円";
    if (node.id === "n17" && !heard.has("u10")) visible.status = "candidate";
    if (node.id === "n6" && !heard.has("u14")) visible.status = "open";
    if (node.id === "n14" && !heard.has("u04")) {
      visible.text = "机を並べても12人全員が座れる？";
      visible.status = "open";
    }
    if (node.id === "n15" && !heard.has("u11")) {
      visible.text = "駅前の土曜午後の室料はいくら？";
      visible.status = heard.has("u06") ? "checking" : "open";
    }
    nodes.set(node.id, visible);
  }
  for (const { id } of spoken) {
    for (const { reaction, ...revision } of revisions[id] ?? []) {
      const node = nodes.get(revision.id)!;
      Object.assign(node, revision);
      node.sourceUtteranceIds.push(id);
      const role = reaction ?? (revision.text ? "statement" : undefined);
      if (role) (node.sourceRoles ??= {})[id] = role;
    }
  }
  const edges: MapEdge[] = [];
  for (const edge of [...checkpoint.edges, ...laterEdges]) {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (!source || !target) continue;
    const result = confirmedRelations.get(edge.id) ?? edge.relation;
    if (
      source.kind === "question" &&
      target.kind === "idea" &&
      isEvidenceRelation(result)
    ) {
      edges.push({
        ...edge,
        relation: source.status === "confirmed" ? result : "asks_about",
      });
    } else {
      edges.push(edge);
    }
  }
  return { nodes: Array.from(nodes.values()), edges };
}
