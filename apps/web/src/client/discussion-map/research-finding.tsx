import type { MapNode, MapResearch } from "./types";

export function ResearchFinding({
  research,
  showAnswer = true,
}: {
  research: MapResearch;
  showAnswer?: boolean;
}) {
  return research.state === "looking" ? (
    <p>AIが調査中です。</p>
  ) : (
    <>
      {showAnswer && <p>{research.answer}</p>}
      {research.source && (
        <a href={research.source.href} target="_blank" rel="noreferrer">
          出典：{research.source.publisher}「{research.source.title}」
        </a>
      )}
    </>
  );
}

export function ResearchReferences({ nodes }: { nodes: MapNode[] }) {
  const cited = nodes.flatMap(({ id, research }) =>
    research && research.state !== "looking" && research.state !== "failed"
      ? [{ id, research }]
      : [],
  );
  if (!cited.length) return null;
  return (
    <section className="panel map-references" aria-label="参考資料">
      <h2>参考資料</h2>
      <ul>
        {cited.map(({ id, research }) => (
          <li key={id}>
            <h3>{research.question}</h3>
            <div className="map-research-finding">
              <ResearchFinding research={research} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
