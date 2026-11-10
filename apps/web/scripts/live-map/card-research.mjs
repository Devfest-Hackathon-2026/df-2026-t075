import { randomUUID } from "node:crypto";

export function roomResearchBudget() {
  return { remaining: 12 };
}

// Only these card fields go to the research service. The transcript, speakers
// and other branches of the discussion are never part of the search request.
function contextFor(graph, node) {
  const linked = (id, relation) =>
    graph.edges
      .filter((e) => e.from === id && e.relation === relation)
      .map((e) => e.to);
  const targets = new Set(
    graph.edges
      .filter(
        (e) =>
          e.from === node.id &&
          [
            "asks_about",
            "supports",
            "opposes",
            "informs",
            "action_for",
            "answers",
          ].includes(e.relation),
      )
      .map((e) => e.to),
  );
  const subjects = new Set(
    graph.nodes
      .filter((n) => n.kind === "idea" && targets.has(n.id))
      .map((n) => n.id),
  );
  if (node.kind === "idea") subjects.add(node.id);
  const topics = new Set([...subjects].flatMap((id) => linked(id, "answers")));
  for (const n of graph.nodes)
    if (n.kind === "topic" && targets.has(n.id)) topics.add(n.id);
  if (node.kind === "topic") topics.add(node.id);
  if (node.kind === "condition")
    for (const id of linked(node.id, "condition_for")) topics.add(id);
  const conditions = new Set(
    graph.edges
      .filter((e) => e.relation === "condition_for" && topics.has(e.to))
      .map((e) => e.from),
  );
  const texts = (ids) =>
    graph.nodes
      .filter(
        (n) => ids.has(n.id) && n.id !== node.id && n.status !== "withdrawn",
      )
      .slice(0, 6)
      .map((n) => n.text);
  return {
    kind: node.kind,
    question: node.text,
    candidates: texts(subjects),
    topics: texts(topics),
    conditions: texts(conditions),
  };
}

function eligible(node) {
  return node && (node.kind !== "question" || node.status === "open");
}

// The classifier can finish a turn while a search is in flight. Keep its
// transcript-derived graph separate from the findings attached by card ID.
export function cardResearch(search, changed, budget) {
  const entries = new Map();
  function discard(id) {
    const entry = entries.get(id);
    entries.delete(id);
    entry?.controller?.abort();
  }
  return {
    available: typeof search === "function",
    request(graph, id, retryId) {
      if (!search) return "research-unavailable";
      const node = graph.nodes.find((item) => item.id === id);
      if (!eligible(node)) return "research-stale";
      const prior = entries.get(id);
      if (prior && (!retryId || retryId !== prior.finding.retryId)) return;
      if (!prior && retryId) return "research-stale";
      if (!budget.remaining) return "research-limit";
      if ([...entries.values()].filter((e) => e.controller).length >= 2)
        return "research-busy";
      const context = contextFor(graph, node);
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(45_000),
      ]);
      const entry = {
        context,
        controller,
        finding: { question: node.text, state: "looking" },
      };
      entries.set(id, entry);
      budget.remaining--;
      changed();
      function finish(result) {
        if (entries.get(id) !== entry || !entry.controller) return;
        entry.controller = null;
        entry.finding = { ...result, question: context.question };
        if (result.state !== "answered") entry.finding.retryId = randomUUID();
        changed();
      }
      const failed = () =>
        finish({
          state: "failed",
          answer: "調査を完了できませんでした。もう一度試せます。",
        });
      signal.addEventListener("abort", failed, { once: true });
      void Promise.resolve()
        .then(() => search(context, signal))
        .then(finish, failed)
        .finally(() => signal.removeEventListener("abort", failed));
    },
    reconcile(graph) {
      for (const [id, entry] of entries) {
        const node = graph.nodes.find((n) => n.id === id);
        // A participant can take over a question or replace it while the
        // request is running. Never attach a late answer to the new question.
        if (
          node?.kind === "question" &&
          node.status === "confirmed" &&
          entry.finding.state === "answered"
        ) {
          // Keep the citation alongside a later human answer on the same subject.
          const { candidates } = contextFor(graph, node);
          if (
            JSON.stringify(candidates) ===
            JSON.stringify(entry.context.candidates)
          )
            continue;
        }
        if (
          !eligible(node) ||
          JSON.stringify(contextFor(graph, node)) !==
            JSON.stringify(entry.context)
        )
          discard(id);
      }
    },
    graph(base) {
      if (!entries.size) return base;
      const nodes = base.nodes.map((node) => {
        const research = entries.get(node.id)?.finding;
        if (!research) return node;
        if (
          node.kind === "question" &&
          node.status === "open" &&
          research.state === "answered"
        )
          return {
            ...node,
            research,
            status: "confirmed",
            text: research.answer,
            reportedBy: "AI",
          };
        if (node.kind === "question" && research.state === "looking")
          return { ...node, research, status: "checking" };
        return { ...node, research };
      });
      const edges = base.edges.map((edge) => {
        const finding = entries.get(edge.from)?.finding;
        return edge.relation === "asks_about" && finding?.state === "answered"
          ? { ...edge, relation: finding.relation ?? "informs" }
          : edge;
      });
      return { nodes, edges };
    },
    end() {
      for (const id of entries.keys()) discard(id);
    },
  };
}
