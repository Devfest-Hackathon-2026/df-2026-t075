import { useState, type FormEvent } from "react";
import { SymbolIcon } from "../components/blocks";
import type { Part } from "./samples";

function partLabel(part: Part, index: number) {
  return part.name.trim() || `パート${index + 1}`;
}

function planError(parts: Part[], minutes: number) {
  if (
    parts.some(
      (part) =>
        !part.name.trim() ||
        !Number.isInteger(part.minutes) ||
        part.minutes < 1,
    )
  )
    return "各パートに名前と1分以上の時間を入れてください。";
  const excess = parts.reduce((sum, part) => sum + part.minutes, 0) - minutes;
  return excess > 0
    ? `予定が部屋の合計時間を${excess}分超えています。パートの分数を減らしてください。`
    : "";
}

export function PreviewPlanForm({
  parts,
  minutes,
  save,
  start,
}: {
  parts: Part[];
  minutes: number;
  save: (parts: Part[]) => void;
  start: (parts: Part[]) => void;
}) {
  const [draft, setDraft] = useState(parts);
  return (
    <PlanForm
      parts={draft}
      minutes={minutes}
      submit={start}
      onChange={(rows) => {
        setDraft(rows);
        if (!planError(rows, minutes)) save(rows);
      }}
    />
  );
}

export function PlanForm({
  parts: draft,
  minutes,
  onChange,
  submit,
  submitLabel = "この進め方で始める",
  saveDraft,
  current = -1,
  busy = false,
  readOnly = false,
}: {
  parts: Part[];
  minutes: number;
  onChange: (parts: Part[]) => void;
  submit: (parts: Part[]) => void;
  submitLabel?: string;
  saveDraft?: (parts: Part[]) => void;
  current?: number;
  busy?: boolean;
  readOnly?: boolean;
}) {
  const [message, setMessage] = useState("");
  function setDraft(edit: (rows: Part[]) => Part[]) {
    setMessage("");
    onChange(edit(draft));
  }
  function update(
    partId: string,
    change: Partial<Pick<Part, "name" | "minutes">>,
  ) {
    setDraft((rows) =>
      rows.map((p) => (p.partId === partId ? { ...p, ...change } : p)),
    );
  }
  function commit(action: (parts: Part[]) => void) {
    const error = planError(draft, minutes);
    setMessage(error);
    if (error) return;
    action(draft);
  }
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!busy && !readOnly) commit(submit);
  }
  return (
    <form className="plan-form" onSubmit={onSubmit}>
      <h3>進め方の案</h3>
      {draft.map((p, i) =>
        i === draft.length - 1 ? (
          <div key={p.partId} className="fixed-part">
            <span>{p.name}</span>
            <small>{p.minutes}分</small>
          </div>
        ) : (
          <div key={p.partId} className="plan-row">
            <input
              aria-label={"パート" + (i + 1) + "の名前"}
              disabled={busy || readOnly || i < current}
              required
              maxLength={40}
              value={p.name}
              onChange={(e) => update(p.partId, { name: e.target.value })}
            />
            <input
              type="number"
              min={1}
              max={minutes}
              disabled={busy || readOnly || i < current}
              required
              aria-label={"パート" + (i + 1) + "の時間（分）"}
              value={p.minutes || ""}
              onChange={(e) =>
                update(p.partId, { minutes: Number(e.target.value) })
              }
            />
            <span>分</span>
            <button
              type="button"
              className="flat-icon"
              aria-label={partLabel(p, i) + "を上へ移動"}
              title="上へ移動"
              disabled={busy || readOnly || i <= current + 1}
              onClick={() =>
                setDraft((rows) => {
                  const reordered = [...rows];
                  reordered.splice(i - 1, 0, ...reordered.splice(i, 1));
                  return reordered;
                })
              }
            >
              ↑
            </button>
            {draft.length > 2 && (
              <button
                type="button"
                className="flat-icon"
                disabled={busy || readOnly || i <= current}
                title="このパートを削除"
                aria-label={partLabel(p, i) + "を削除"}
                onClick={() =>
                  setDraft((rows) =>
                    rows.filter((row) => row.partId !== p.partId),
                  )
                }
              >
                <SymbolIcon name="close" />
              </button>
            )}
          </div>
        ),
      )}
      <button
        disabled={
          busy || readOnly || current >= draft.length - 1 || draft.length >= 60
        }
        className="small-action"
        type="button"
        onClick={() =>
          setDraft((rows) => [
            ...rows.slice(0, -1),
            { partId: crypto.randomUUID(), name: "", minutes: 1, notes: [] },
            ...rows.slice(-1),
          ])
        }
      >
        <SymbolIcon name="add" />
        パートを追加
      </button>
      {message && <small role="alert">{message}</small>}
      {saveDraft && (
        <button
          type="button"
          className="btn"
          disabled={busy || readOnly}
          onClick={() => commit(saveDraft)}
        >
          案を共有する
        </button>
      )}
      <button type="submit" className="btn primary" disabled={busy || readOnly}>
        {submitLabel}
      </button>
    </form>
  );
}
