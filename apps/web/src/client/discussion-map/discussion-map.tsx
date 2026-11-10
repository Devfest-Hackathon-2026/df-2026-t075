import { useMemo, useRef } from "react";
import { mapLayout } from "./columns";
import { MapNodeCard } from "./map-node-card";
import { MapViewport } from "./map-viewport";
import { ResearchFinding } from "./research-finding";
import { SpeakerBadge } from "./speaker-badge";
import type { DiscussionGraph, MapNode, Utterance } from "./types";
import "./discussion-map.css";

const relationLabels = {
  answers: ["この案が答える論点", "この論点への案"],
  supports: ["この理由が支える案", "案を支える理由"],
  condition_for: ["この条件が属する論点", "この論点の条件"],
  action_for: ["この作業の対象", "関連するやること"],
  asks_about: ["確認の対象", "この案の確認事項"],
  informs: ["この情報が関わる案", "この案の参考情報"],
  opposes: ["この根拠が不利に働く案", "この案に不利な根拠"],
  reason_for_exclusion: ["見送りを検討した案", "見送りの理由"],
  revises_condition: ["見直した条件", "条件を見直した理由"],
  cites: ["判断の根拠", "この項目を根拠にした判断"],
} as const;

function columnLabel(level: number, nodes: MapNode[]) {
  if (nodes[0]?.kind === "action") return "やること";
  if (level === 2 && nodes.some((node) => node.kind === "note"))
    return "理由・確認結果・補足";
  return ["論点・条件", "候補", "理由・確認結果"][level] ?? "関連する根拠";
}

export function DiscussionMap({
  graph,
  utterances,
  speakerColors,
  selectedId,
  onSelect,
  onRequestResearch,
}: {
  graph: DiscussionGraph;
  utterances: Utterance[];
  speakerColors: ReadonlyMap<string, string>;
  selectedId: string;
  onSelect: (id: string) => void;
  onRequestResearch?: (id: string) => void;
}) {
  const chart = useRef<HTMLElement>(null);
  const { columns, rows, edges, pendingByIdea, evidenceByNode } = useMemo(
    () => mapLayout(graph),
    [graph],
  );
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const reasonLabels = new Map<string, string>();
  for (const edge of graph.edges) {
    if (
      edge.relation === "reason_for_exclusion" ||
      edge.relation === "revises_condition"
    )
      reasonLabels.set(edge.from, relationLabels[edge.relation][1]);
  }
  const evidenceHeading = useRef<HTMLHeadingElement>(null);
  const selected = graph.nodes.find((node) => node.id === selectedId);
  const speakerByTurn = new Map(
    utterances.map((turn) => [turn.id, turn.speaker]),
  );
  function showEvidence(id: string) {
    onSelect(id);
    const heading = evidenceHeading.current;
    if (
      heading &&
      chart.current &&
      heading.getBoundingClientRect().top >=
        chart.current.getBoundingClientRect().bottom
    ) {
      heading.focus();
    }
  }
  function renderCard(
    node: MapNode,
    { isTopic = false, topicWide = false } = {},
  ) {
    return (
      <MapNodeCard
        key={node.id}
        node={node}
        isTopic={isTopic}
        topicWide={topicWide}
        reasonLabel={reasonLabels.get(node.id)}
        result={evidenceByNode.get(node.id)}
        selected={selectedId === node.id}
        speakerByTurn={speakerByTurn}
        speakerColors={speakerColors}
        onSelect={showEvidence}
      />
    );
  }
  function renderBranchNode(node: MapNode, topicWide: boolean) {
    if (node.kind !== "idea") return renderCard(node, { topicWide });
    const checks = pendingByIdea.get(node.id);
    return (
      <div className="map-candidate" key={node.id}>
        {renderCard(node)}
        {checks && (
          <div
            className="map-pending-checks"
            role="group"
            aria-label={`「${node.text}」の確認事項`}
          >
            {checks.map((check) => (
              <div key={check.id} className="map-check">
                {renderCard(check)}
                {onRequestResearch &&
                  check.status === "open" &&
                  !check.research && (
                    <button
                      type="button"
                      className="small-action map-request"
                      aria-label={`「${check.text}」をAIに調べてもらう`}
                      onClick={() => {
                        onRequestResearch(check.id);
                        showEvidence(check.id);
                        evidenceHeading.current?.focus();
                      }}
                    >
                      AIに調べてもらう
                    </button>
                  )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="discussion-map">
      <section
        ref={chart}
        className="map-chart panel"
        aria-label="議論のつながり"
      >
        <MapViewport edges={edges} selectedId={selectedId}>
          <div className="map-column-headings">
            {columns.map(([level, nodes]) => (
              <h3
                key={level}
                className="map-lane-title"
                style={{ gridColumn: level + 1 }}
              >
                {columnLabel(level, nodes)}
              </h3>
            ))}
          </div>
          {rows.map(({ topic, lanes, bands }) => (
            <div
              className="map-topic-row"
              key={topic?.id ?? "unassigned"}
              style={{
                gridTemplateRows: `repeat(${bands.count}, max-content)`,
              }}
              role="group"
              aria-label={topic?.text ?? "その他の項目"}
            >
              {lanes.map(([level, nodes]) => (
                <div
                  key={level}
                  className={
                    level === 0
                      ? "map-lane map-topics"
                      : "map-lane map-branch-lane"
                  }
                  style={{ gridColumn: level + 1 }}
                  role="group"
                  aria-label={columnLabel(level, nodes)}
                >
                  {level === 0
                    ? nodes.map((node) =>
                        renderCard(node, { isTopic: node.id === topic?.id }),
                      )
                    : Array.from(bands.cells.get(level)!, ([row, items]) => (
                        <div
                          className="map-branch-cell"
                          style={{ gridRow: row }}
                          key={row}
                        >
                          {items.map((node) =>
                            renderBranchNode(
                              node,
                              bands.topicActions.has(node.id),
                            ),
                          )}
                        </div>
                      ))}
                </div>
              ))}
            </div>
          ))}
        </MapViewport>
      </section>
      <aside className="map-evidence panel" aria-label="根拠の発言">
        <div className="map-evidence-heading">
          <h2 tabIndex={-1} ref={evidenceHeading}>
            根拠の発言
          </h2>
          <button
            type="button"
            className="small-action"
            onClick={() =>
              chart.current
                ?.querySelector<HTMLButtonElement>(
                  '.map-node[aria-pressed="true"]',
                )
                ?.focus()
            }
          >
            マップに戻る
          </button>
        </div>
        {selected ? (
          <>
            <p className="map-evidence-subject">
              {selected.research?.question ?? selected.text}
            </p>
            {selected.research && (
              <div className="map-research-finding" role="status">
                <ResearchFinding research={selected.research} />
                {selected.status === "confirmed" && !selected.reportedBy && (
                  <p>参加者の確認結果：{selected.text}</p>
                )}
              </div>
            )}
            <ol className="map-quotes">
              {utterances.map(
                (turn, index) =>
                  selected.sourceUtteranceIds.includes(turn.id) && (
                    <li
                      key={turn.id}
                      style={{ borderColor: speakerColors.get(turn.speaker) }}
                    >
                      <span className="map-byline">
                        <span className="map-turn-index">発言 {index + 1}</span>
                        <SpeakerBadge
                          name={turn.speaker}
                          colors={speakerColors}
                        />
                      </span>
                      <blockquote>{turn.text}</blockquote>
                    </li>
                  ),
              )}
            </ol>
            <ul className="map-relations" aria-label="選んだ項目との関係">
              {graph.edges
                .filter(
                  (edge) => edge.from === selectedId || edge.to === selectedId,
                )
                .map((edge) => {
                  const outgoing = edge.from === selectedId;
                  const neighbor = byId.get(outgoing ? edge.to : edge.from);
                  return (
                    neighbor && (
                      <li key={edge.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(neighbor.id)}
                        >
                          <span>
                            {relationLabels[edge.relation][outgoing ? 0 : 1]}
                          </span>
                          {neighbor.text}
                        </button>
                      </li>
                    )
                  );
                })}
            </ul>
          </>
        ) : (
          <p>項目を選んでください。</p>
        )}
      </aside>
    </div>
  );
}
