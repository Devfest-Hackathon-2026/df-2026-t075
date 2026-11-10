import { useRef, useState, type FormEvent } from "react";
import type { useMeetingAgenda } from "../infrastructure/use-meeting-agenda";
import { proposalStatusMessage } from "../infrastructure/rooms";
import { PlanForm } from "../preview/plan-form";
import type { Part } from "../preview/samples";
import { SymbolIcon } from "./blocks";
import { PartList } from "./part-list";

type Meeting = ReturnType<typeof useMeetingAgenda>;

function countdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

export function MeetingTime({
  meeting,
  minutes,
}: {
  meeting: Meeting;
  minutes: number;
}) {
  const { agenda, now } = meeting;
  if (!agenda)
    return (
      <>
        <small>残り</small>—:—
      </>
    );
  if (agenda.startsAt === null || agenda.endsAt === null)
    return (
      <>
        <small>開始前</small>
        {countdown(minutes * 60_000)}
      </>
    );
  const planning = now < agenda.startsAt;
  return (
    <>
      <small>{planning ? "準備の残り" : "全体の残り"}</small>
      <span role="timer">
        {countdown((planning ? agenda.startsAt : agenda.endsAt) - now)}
      </span>
    </>
  );
}

function PhaseNoteForm({
  partId,
  edit,
  busy,
}: {
  partId: string;
  edit: Meeting["edit"];
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const draft = useRef<{ text: string; id: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    if (draft.current?.text !== value)
      draft.current = { text: value, id: crypto.randomUUID() };
    if (
      await edit({
        action: "note",
        id: draft.current.id,
        partId,
        text: value,
      })
    ) {
      setText("");
      draft.current = null;
    }
  }
  return (
    <form className="add-note" onSubmit={submit}>
      <label className="field">
        共有メモを書き足す
        <input
          maxLength={180}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className="small-action"
        disabled={busy || !text.trim()}
      >
        <SymbolIcon name="add" />
        追記する
      </button>
    </form>
  );
}

// Reconcile by identity: a draft can omit the active part or move a future
// part ahead of it. Keep the user's edits on every row that is still editable.
function draftRecovery(shared: Part[], draft: Part[], current: number) {
  const started = shared.slice(0, current + 1);
  const mismatch = started.find((part, i) => {
    const row = draft[i];
    return (
      row?.partId !== part.partId ||
      (i < current &&
        (row.name.trim() !== part.name || row.minutes !== part.minutes))
    );
  });
  if (!mismatch) return null;
  const active = shared[current]!;
  const startedIds = new Set(started.map((part) => part.partId));
  return {
    reason:
      mismatch.partId === active.partId
        ? `「${active.name}」が始まりました。下書きでもこのパートを${current + 1}番目に戻してください。`
        : `「${mismatch.name}」は終了しました。下書きの終了済みパートを、共有中の内容と順番に戻してください。`,
    parts: [
      ...shared.slice(0, current),
      draft.find((part) => part.partId === active.partId) ?? active,
      ...draft.filter((part) => !startedIds.has(part.partId)),
    ],
  };
}

export function MeetingAgenda({
  meeting,
  minutes,
  owner,
  open,
  onClose,
}: {
  meeting: Meeting;
  minutes: number;
  owner: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const { agenda, now, edit, busy } = meeting;
  const waiting = agenda?.startsAt === null;
  const planning = agenda?.startsAt != null && now < agenda.startsAt;
  const next =
    agenda?.parts.findIndex((p) => p.endsAt !== null && now < p.endsAt) ?? -1;
  const current =
    !agenda || waiting || planning ? -1 : next < 0 ? agenda.parts.length : next;
  const part = agenda?.parts[current];
  const [draft, setDraft] = useState<{
    planVersion: number;
    parts: Part[];
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const conflict =
    draft !== null &&
    agenda !== undefined &&
    draft.planVersion !== agenda.planVersion;
  const canEdit = !!agenda && !waiting && current < agenda.parts.length - 1;
  const recovery =
    draft && agenda && !conflict && canEdit && current >= 0
      ? draftRecovery(agenda.parts, draft.parts, current)
      : null;
  const showForm =
    !!agenda && (draft !== null || (canEdit && (planning || editing)));
  function discard() {
    setDraft(null);
    setEditing(false);
    meeting.clearWriteError();
  }
  async function updatePlan(action: "confirm" | "save", parts: Part[]) {
    if (!agenda) return;
    const savedIds = new Set(agenda.parts.map((p) => p.partId));
    const saved = await edit({
      action,
      planVersion: draft?.planVersion ?? agenda.planVersion,
      parts: parts.map(({ partId, name, minutes }) => ({
        partId: savedIds.has(partId) ? partId : null,
        name,
        minutes,
      })),
    });
    if (saved) discard();
  }
  const notice =
    agenda?.proposalStatus &&
    (proposalStatusMessage(agenda.proposalStatus) ??
      "AIの変更案を取り下げました。");
  const proposal = agenda?.proposal ?? agenda?.appliedProposal;
  if (!open) return null;
  return (
    <aside className="agenda panel" aria-label="進行メモ">
      <div className="agenda-heading">
        <h2>進行メモ</h2>
        <button
          type="button"
          className="flat-icon"
          aria-label="進行メモを閉じる"
          onClick={onClose}
        >
          <SymbolIcon name="close" />
        </button>
      </div>
      {meeting.readError && (
        <p role="alert" className="form-error">
          {meeting.readError}{" "}
          <button className="small-action" onClick={meeting.refresh}>
            再確認する
          </button>
        </p>
      )}
      {!agenda && !meeting.readError && (
        <p role="status">進行メモを読み込み中…</p>
      )}
      {proposal && (
        <section aria-label="AIによる予定変更">
          <h3>{agenda?.proposal ? "AIの変更案" : "AIの提案で反映した変更"}</h3>
          <p>{proposal.reason}</p>
          <ul>
            {proposal.changes.map((change, index) => (
              <li key={index}>{change}</li>
            ))}
          </ul>
          {agenda?.proposal && (
            <>
              {" "}
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  void edit({ action: "approve", id: agenda.proposal!.id })
                }
              >
                この変更を反映する
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void edit({ action: "dismiss", id: agenda.proposal!.id })
                }
              >
                見送る
              </button>
            </>
          )}
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      {planning && (
        <p className="agenda-guidance">
          準備の時間が終わると、共有中の案で始まります。
        </p>
      )}
      {agenda && showForm && (
        <>
          {conflict && (
            <div role="status">
              <p>
                共有予定が更新されました。下書きと最新の案を確認してください。
              </p>
              <strong>最新の案</strong>
              <ol>
                {agenda.parts.map((p) => (
                  <li key={p.partId}>
                    {p.name}（{p.minutes}分）
                  </li>
                ))}
              </ol>
            </div>
          )}
          {recovery && draft && (
            <div>
              <p role="status">{recovery.reason}</p>
              <button
                type="button"
                className="small-action"
                disabled={busy}
                onClick={() => {
                  setDraft({ ...draft, parts: recovery.parts });
                  meeting.clearWriteError();
                }}
              >
                進行に合わせて下書きを直す
              </button>
              <small>今後のパートへの編集は残ります。</small>
            </div>
          )}
          {draft && !canEdit && (
            <p role="status">
              討議パートがすべて終了したため、この下書きの編集は終了しました。
            </p>
          )}
          <PlanForm
            parts={draft?.parts ?? agenda.parts}
            minutes={minutes}
            current={current}
            busy={busy}
            readOnly={conflict || !!recovery || !canEdit}
            onChange={(parts) => {
              meeting.clearWriteError();
              setDraft({
                planVersion: draft?.planVersion ?? agenda.planVersion,
                parts,
              });
            }}
            {...(planning
              ? { saveDraft: (parts: Part[]) => void updatePlan("save", parts) }
              : { submitLabel: "予定を保存する" })}
            submit={(parts) =>
              void updatePlan(planning ? "confirm" : "save", parts)
            }
          />
          {(draft || editing) && (
            <button
              type="button"
              className="small-action"
              disabled={busy}
              onClick={() => {
                discard();
                if (conflict) setEditing(true);
              }}
            >
              {conflict
                ? "下書きを破棄して最新の案から編集"
                : draft
                  ? "下書きを破棄する"
                  : "編集を閉じる"}
            </button>
          )}
        </>
      )}
      {agenda && !planning && (
        <>
          {canEdit && !showForm && (
            <button
              type="button"
              className="small-action"
              onClick={() => setEditing(true)}
            >
              予定を編集する
            </button>
          )}
          {waiting && (
            <p className="agenda-guidance">
              {owner
                ? "みんながそろったら、進め方を相談しましょう。"
                : "主催者が話し合いを始めるのを待っています。"}
            </p>
          )}
          {current === agenda.parts.length && (
            <p className="agenda-guidance">
              予定したフェーズがすべて終わりました。
            </p>
          )}
          {part?.endsAt != null && (
            <p className="phase-clock">
              <span>このフェーズの残り</span>
              <strong>{countdown(part.endsAt - now)}</strong>
            </p>
          )}
          <PartList
            parts={agenda.parts}
            current={current}
            noteForm={(partId, index) =>
              index <= current && index < agenda.parts.length - 1 ? (
                <PhaseNoteForm partId={partId} edit={edit} busy={busy} />
              ) : null
            }
          />
          {waiting && owner && (
            <button
              className="btn primary start-meeting"
              disabled={busy}
              onClick={() => void edit({ action: "start" })}
            >
              話し合いを始める
              <SymbolIcon name="forward" />
            </button>
          )}
        </>
      )}
      {meeting.writeError && meeting.writeError !== notice && (
        <p role="alert" className="form-error">
          {meeting.writeError}
        </p>
      )}
    </aside>
  );
}
