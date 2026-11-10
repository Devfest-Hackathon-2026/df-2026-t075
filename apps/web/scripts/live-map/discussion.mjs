// Only resend the most recent transcripts to the model. The room keeps the
// complete map and all of its source turns until it ends.
const transcriptWindow = 60;
const maxPendingTurns = 12;

// One in-memory queue per room. STT can finish out of order; only the next
// accepted turn can update the graph. Audio playout never waits for this queue.
export function discussion({ recognize, predict }, changed, now = Date.now) {
  const controller = new AbortController();
  const turns = [];
  let graph = { nodes: [], edges: [] },
    cursor = 0,
    busy = false,
    retries = 0;
  const live = () => !controller.signal.aborted;
  function add(speaker, text) {
    if (!live() || turns.length - cursor >= maxPendingTurns) return null;
    const turn = {
      id: "u" + String(turns.length + 1).padStart(2, "0"),
      speaker,
      text,
      state: text ? "queued" : "recognizing",
      receivedAt: now(),
    };
    turns.push(turn);
    changed();
    return turn;
  }
  async function pump() {
    if (busy || !live()) return;
    busy = true;
    try {
      while (live() && cursor < turns.length) {
        const turn = turns[cursor];
        if (["unheard", "speech-error", "skipped"].includes(turn.state)) {
          cursor++;
          continue;
        }
        if (turn.state !== "queued") break;
        turn.state = "mapping";
        changed();
        try {
          const through = cursor + 1;
          const heard = turns
            .slice(Math.max(0, through - transcriptWindow), through)
            .filter((t) => t.text)
            .map(({ id, speaker, text }) => ({ id, speaker, text }));
          const result = await predict(heard, graph, controller.signal);
          if (!live()) return;
          graph = result;
          turn.state = "mapped";
          turn.delayMs = now() - turn.receivedAt;
          cursor++;
          retries = 0;
        } catch {
          if (!live()) return;
          turn.state = "failed";
          break;
        }
      }
    } finally {
      busy = false;
      if (live()) changed();
    }
  }
  return {
    snapshot: () => ({
      graph,
      turns,
      waiting: turns.length - cursor,
      canRetry: retries < 2,
    }),
    text(speaker, text) {
      if (!add(speaker, text)) return false;
      void pump();
      return true;
    },
    audio(speaker, pcm) {
      const turn = add(speaker, "");
      if (!turn) return false;
      void (async () => {
        let text = "";
        let failed = false;
        try {
          text = (await recognize(pcm, controller.signal))
            .trim()
            .slice(0, 2000);
        } catch {
          failed = true; // Never log audio or original SDK errors.
        }
        if (!live()) return;
        turn.text = text;
        turn.state = text ? "queued" : failed ? "speech-error" : "unheard";
        changed();
        void pump();
      })();
      return true;
    },
    recover(id, skip) {
      const turn = turns[cursor];
      if (
        !turn ||
        turn.id !== id ||
        turn.state !== "failed" ||
        (!skip && retries >= 2)
      )
        return;
      if (skip) retries = 0;
      else retries++;
      turn.state = skip ? "skipped" : "queued";
      void pump();
    },
    end() {
      controller.abort();
      turns.length = 0;
      graph = { nodes: [], edges: [] };
    },
  };
}
