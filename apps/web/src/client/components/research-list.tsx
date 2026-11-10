import { useState, type Ref } from "react";
import type { RoomResearch } from "../infrastructure/rooms";

const messages = {
  pending: "調べています",
  unverified: "未確認 · 指定された条件に合う資料を確認できませんでした。",
  failed: "資料の取得に失敗しました。",
  timeout: "調査が時間切れになりました。",
};

export function ResearchList({ rows }: { rows: RoomResearch[] }) {
  if (!rows.length) return null;
  return (
    <section className="panel research-list" aria-label="参考資料">
      <h2>参考資料</h2>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <strong>{row.question}</strong>
            {row.status === "verified" && row.finding ? (
              <>
                <p>{row.finding.answer}</p>
                <p className="meta">{row.finding.conditions}</p>
                <a
                  href={row.finding.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {row.finding.title}（{row.finding.publisher}）
                </a>
                {row.finding.license === "CC-BY-4.0" && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href="https://creativecommons.org/licenses/by/4.0/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      CC BY 4.0
                    </a>
                  </>
                )}
              </>
            ) : (
              row.status !== "verified" && <p>{messages[row.status]}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MapResearchTools({
  rows,
  presentationRef,
}: {
  rows: RoomResearch[];
  presentationRef: Ref<HTMLSpanElement>;
}) {
  const [open, setOpen] = useState(false);
  const latest = rows.at(-1);
  return (
    <div className="map-research-tools">
      <span role="status">
        {latest?.status === "verified"
          ? !latest.presented && "調査結果が届きました"
          : latest && messages[latest.status]}
      </span>
      {latest && (
        <button
          type="button"
          className="btn"
          aria-expanded={open}
          aria-controls="map-references"
          onClick={() => setOpen(!open)}
        >
          {open ? "参考資料を閉じる" : "参考資料を開く"}
        </button>
      )}
      <span className="map-voice-actions" ref={presentationRef} />
      <div id="map-references" hidden={!open}>
        <ResearchList rows={rows} />
      </div>
    </div>
  );
}
