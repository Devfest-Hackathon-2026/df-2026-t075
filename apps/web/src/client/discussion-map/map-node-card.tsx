import { SpeakerBadge } from "./speaker-badge";
import type { EvidenceRelation, MapNode, MapReaction } from "./types";

const kinds = {
  topic: "論点",
  question: "確認事項",
  idea: "案",
  reason: "理由",
  condition: "条件",
  note: "補足",
  action: "やること",
};
const statuses = {
  open: "検討中",
  candidate: "候補",
  checking: "確認中",
  confirmed: "確認済み",
  "proposed-removal": "見送りを提案",
  excluded: "見送り",
  relaxed: "緩和",
  withdrawn: "撤回",
  decided: "決定",
  pending: "未完了",
  completed: "完了",
};

function statusLabel(kind: keyof typeof kinds, node: MapNode) {
  const { status } = node;
  if (!status) return;
  if (kind === "topic" && status === "decided") return "検討終了";
  if (kind === "question" && status === "open") return "未確認";
  if (node.research?.state === "looking" && status === "checking")
    return "AIが調査中";
  return statuses[status];
}
const reactions = [
  { kind: "agree", emoji: "👍" },
  { kind: "disagree", emoji: "👎" },
] as const;
const resultLabels: Record<EvidenceRelation, string> = {
  supports: "補強材料",
  opposes: "見送り材料",
  informs: "確認結果",
};

export function MapNodeCard({
  node,
  isTopic,
  topicWide,
  reasonLabel,
  result,
  selected,
  speakerByTurn,
  speakerColors,
  onSelect,
}: {
  node: MapNode;
  isTopic: boolean;
  topicWide: boolean;
  reasonLabel: string | undefined;
  result: EvidenceRelation | undefined;
  selected: boolean;
  speakerByTurn: ReadonlyMap<string, string>;
  speakerColors: ReadonlyMap<string, string>;
  onSelect: (id: string) => void;
}) {
  const kind = isTopic ? "topic" : node.kind;
  const status = statusLabel(kind, node);
  let author: string | undefined;
  const latestReaction = new Map<string, MapReaction>();
  for (const id of node.sourceUtteranceIds) {
    const speaker = speakerByTurn.get(id);
    if (speaker === undefined) continue;
    const role = node.sourceRoles?.[id];
    if (role === "agree" || role === "disagree")
      latestReaction.set(speaker, role);
    else if (id === node.sourceUtteranceIds[0] || role === "statement")
      author = speaker;
  }
  const names: Record<MapReaction, string[]> = { agree: [], disagree: [] };
  author = node.reportedBy ?? author;
  for (const [speaker, reaction] of latestReaction)
    names[reaction].push(speaker);

  return (
    <button
      type="button"
      data-map-node={node.id}
      data-kind={kind}
      data-status={node.status}
      data-result={result}
      className="map-node"
      aria-pressed={selected}
      onClick={() => onSelect(node.id)}
    >
      <span className="map-node-meta">
        <span className="map-node-type">
          {result ? resultLabels[result] : (reasonLabel ?? kinds[kind])}
          {topicWide && <span>論点全体</span>}
          {status && <span>{status}</span>}
        </span>
        {kind === "action" && node.assignee ? (
          <span className="map-action-people">
            <span>
              担当 <SpeakerBadge name={node.assignee} colors={speakerColors} />
            </span>
            {author && author !== node.assignee && (
              <span>
                発言 <SpeakerBadge name={author} colors={speakerColors} />
              </span>
            )}
          </span>
        ) : (
          author && <SpeakerBadge name={author} colors={speakerColors} />
        )}
      </span>
      <strong>{node.text}</strong>
      {latestReaction.size > 0 && (
        <span className="map-node-reactions">
          {reactions.map(({ kind: reaction, emoji }) =>
            names[reaction].length > 0 ? (
              <span className="map-reaction" key={reaction}>
                <span>{emoji}</span>
                <span className="map-reaction-names">
                  {names[reaction].map((name) => (
                    <SpeakerBadge
                      key={name}
                      name={name}
                      colors={speakerColors}
                    />
                  ))}
                </span>
              </span>
            ) : null,
          )}
        </span>
      )}
    </button>
  );
}
