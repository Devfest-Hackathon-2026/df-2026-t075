import type { MapNode } from "./types";

/** Assign a shared grid row to each idea and the evidence reached from it. */
export function candidateBands(
  lanes: ReadonlyMap<number, MapNode[]>,
  children: ReadonlyMap<string, string[]>,
  topicId?: string,
) {
  const columns = [...lanes].filter(([level]) => level > 0);
  const items = new Map(
    columns.flatMap(([, nodes]) =>
      nodes.map((node) => [node.id, node] as const),
    ),
  );
  const rowById = new Map<string, number>();
  let nextRow = 1;
  for (const idea of items.values()) {
    if (idea.kind !== "idea") continue;
    const row = nextRow++;
    const queue = [idea.id];
    rowById.set(idea.id, row);
    // Shared evidence stays with the first idea, with its other links intact.
    for (const id of queue) {
      for (const child of children.get(id) ?? []) {
        const node = items.get(child);
        if (!node || node.kind === "idea" || rowById.has(child)) continue;
        rowById.set(child, row);
        queue.push(child);
      }
    }
  }
  const topicActions = new Set<string>();
  if (topicId) {
    for (const id of children.get(topicId) ?? []) {
      if (items.get(id)?.kind === "action" && !rowById.has(id)) {
        topicActions.add(id);
        rowById.set(id, 1);
      }
    }
  }
  let count = Math.max(1, nextRow - 1);
  const cells = new Map<number, Map<number, MapNode[]>>();
  for (const [level, nodes] of columns) {
    const lane = new Map<number, MapNode[]>();
    for (const node of nodes) {
      // Keep evidence without an attached idea visible after the last idea.
      const row = rowById.get(node.id) ?? nextRow;
      count = Math.max(count, row);
      const cell = lane.get(row) ?? [];
      cell.push(node);
      lane.set(row, cell);
    }
    // Within a shared row, the proposal's own work starts level with the proposal.
    if (nodes[0]?.kind === "action" && topicActions.size) {
      lane
        .get(1)
        ?.sort(
          (a, b) =>
            Number(topicActions.has(a.id)) - Number(topicActions.has(b.id)),
        );
    }
    cells.set(level, lane);
  }
  return { cells, count, topicActions };
}
