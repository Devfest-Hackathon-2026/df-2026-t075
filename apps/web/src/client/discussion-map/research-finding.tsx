import type { MapResearch } from "./types";

export function ResearchFinding({ research }: { research: MapResearch }) {
  return research.state === "looking" ? (
    <p>AIが調査中です。</p>
  ) : (
    <>
      <p>{research.answer}</p>
      <a href={research.source.href} target="_blank" rel="noreferrer">
        出典：{research.source.publisher}「{research.source.title}」
      </a>
    </>
  );
}
