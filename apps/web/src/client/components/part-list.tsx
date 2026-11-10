import { type Part } from "../preview/samples";
import type { ReactNode } from "react";
import { SymbolIcon } from "./blocks";

export function PartList({
  parts,
  current,
  noteForm,
}: {
  parts: Part[];
  current?: number;
  noteForm?: (partId: string, index: number) => ReactNode;
}) {
  return (
    <div className="part-list">
      {parts.map((part, i) => {
        const done = current === undefined || i < current;
        return (
          <details
            key={part.partId}
            open={current === undefined || i === current}
            className={"part-row " + (i === current ? "current" : "")}
          >
            <summary aria-current={i === current ? "step" : undefined}>
              <span
                aria-label={done ? "完了" : undefined}
                className={"part-number " + (done ? "green" : "")}
              >
                {done ? <SymbolIcon name="check" /> : i + 1}
              </span>
              <span>{part.name}</span>
              <small>{part.minutes}分</small>
              <SymbolIcon name="down" />
            </summary>
            <div className="part-body">
              {part.aim && <p>ねらい：{part.aim}</p>}
              {part.notes.length ? (
                <ul>
                  {part.notes.map((note, j) => (
                    <li key={j}>{note}</li>
                  ))}
                </ul>
              ) : (
                <small>
                  {i === parts.length - 1 && part.name === "振り返り"
                    ? "個人の振り返り"
                    : "メモはまだありません"}
                </small>
              )}
              {noteForm?.(part.partId, i)}
            </div>
          </details>
        );
      })}
    </div>
  );
}
