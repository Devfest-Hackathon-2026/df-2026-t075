// IDs and Japanese summaries differ across runs. Match on the introducing
// utterance and kind; repeated keys count only up to the smaller multiplicity.
function features(graph) {
  const anchor = new Map(
    graph.nodes.map((node) => [
      node.id,
      node.sourceUtteranceIds[0] + "/" + node.kind,
    ]),
  );
  return {
    kinds: [...anchor.values()],
    statuses: graph.nodes
      .filter((n) => n.status)
      .map((n) => anchor.get(n.id) + "/" + n.status),
    assignees: graph.nodes
      .filter((n) => n.assignee)
      .map((n) => anchor.get(n.id) + "/" + n.assignee),
    reactions: graph.nodes.flatMap((n) =>
      Object.entries(n.sourceRoles ?? {})
        .filter(([, role]) => role === "agree" || role === "disagree")
        .map(([turn, role]) => [anchor.get(n.id), turn, role].join("/")),
    ),
    relations: graph.edges.map((e) =>
      [anchor.get(e.from), e.relation, anchor.get(e.to)].join("/"),
    ),
  };
}

function compare(expected, predicted) {
  const left = new Map();
  for (const item of expected) left.set(item, (left.get(item) ?? 0) + 1);
  let matched = 0;
  for (const item of predicted) {
    const count = left.get(item) ?? 0;
    if (count > 0) {
      left.set(item, count - 1);
      matched++;
    }
  }
  return { matched, expected: expected.length, predicted: predicted.length };
}

export function scoreMap(expected, predicted) {
  const gold = features(expected),
    actual = features(predicted);
  return Object.fromEntries(
    Object.keys(gold).map((metric) => [
      metric,
      compare(gold[metric], actual[metric]),
    ]),
  );
}
