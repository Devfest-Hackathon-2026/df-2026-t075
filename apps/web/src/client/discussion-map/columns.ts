import { candidateBands } from "./candidate-bands";
import {
  isEvidenceRelation,
  type EvidenceRelation,
  type DiscussionGraph,
  type MapEdge,
  type MapNode,
} from "./types";

type Column = [number, MapNode[]];

function rowsByTopic(columns: Column[], edges: MapEdge[]) {
  const first = columns.find(([level]) => level === 0)?.[1] ?? [];
  // The original demo recorded its root topics as question cards.
  const explicitTopics = first.filter((node) => node.kind === "topic");
  const topics = explicitTopics.length
    ? explicitTopics
    : first.filter((node) => node.kind === "question");
  const children = new Map<string, string[]>();
  for (const { from, to, relation } of edges) {
    if (relation === "cites") continue;
    const list = children.get(to) ?? [];
    list.push(from);
    children.set(to, list);
  }
  // Start with every topic so a shared item belongs to the nearest one.
  const owner = new Map(topics.map((topic) => [topic.id, topic]));
  const queue = [...owner.keys()];
  for (const id of queue) {
    for (const child of children.get(id) ?? []) {
      if (owner.has(child)) continue;
      owner.set(child, owner.get(id)!);
      queue.push(child);
    }
  }
  const rows = new Map<MapNode | undefined, Map<number, MapNode[]>>();
  for (const [level, nodes] of columns) {
    for (const node of nodes) {
      const topic = owner.get(node.id);
      const lanes = rows.get(topic) ?? new Map<number, MapNode[]>();
      const lane = lanes.get(level) ?? [];
      lane.push(node);
      lanes.set(level, lane);
      rows.set(topic, lanes);
    }
  }
  return [...rows].map(([topic, lanes]) => ({
    topic,
    lanes: [...lanes],
    bands: candidateBands(lanes, children, topic?.id),
  }));
}

export function mapLayout(graph: DiscussionGraph) {
  const { nodes } = graph;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pending = new Set<string>();
  const pendingByIdea = new Map<string, MapNode[]>();
  const evidenceByNode = new Map<string, EvidenceRelation>();
  for (const edge of graph.edges) {
    const item = byId.get(edge.from);
    if (
      (item?.kind !== "question" && item?.kind !== "reason") ||
      byId.get(edge.to)?.kind !== "idea"
    )
      continue;
    const effect =
      item.kind === "question" && edge.relation === "asks_about"
        ? "informs"
        : edge.relation;
    if (!isEvidenceRelation(effect)) continue;
    if (item.kind === "question" && item.status !== "confirmed") {
      pending.add(item.id);
      const items = pendingByIdea.get(edge.to) ?? [];
      if (!items.includes(item)) items.push(item);
      pendingByIdea.set(edge.to, items);
      continue;
    }
    // The evidence panel shows the individual effects of a shared fact.
    const previous = evidenceByNode.get(item.id);
    evidenceByNode.set(
      item.id,
      previous && previous !== effect ? "informs" : effect,
    );
  }
  // A condition's owner and revision history determine its place in the list,
  // even though no line is drawn to or from a condition card.
  const leftParent = new Map(
    graph.edges
      .filter(
        (edge) =>
          edge.relation === "condition_for" ||
          edge.relation === "revises_condition",
      )
      .map((edge) => [edge.from, edge.to]),
  );
  // Keep the semantic links for grouping and source navigation. These cards
  // express their relationship through placement rather than a canvas line.
  const withoutLines = new Set(pending);
  const actions = nodes.filter((node) => node.kind === "action");
  for (const node of nodes) {
    if (node.kind === "condition" || node.kind === "action")
      withoutLines.add(node.id);
  }
  const edges = graph.edges.filter(
    ({ from, to, relation }) =>
      relation !== "cites" && !withoutLines.has(from) && !withoutLines.has(to),
  );
  function firstColumn(node: MapNode) {
    if (
      node.kind === "topic" ||
      node.kind === "condition" ||
      leftParent.has(node.id) ||
      (node.kind === "question" && !evidenceByNode.has(node.id))
    )
      return 0;
    return node.kind === "idea" ? 1 : 2;
  }

  const slots = new Map(
    nodes
      .filter((node) => !pending.has(node.id) && node.kind !== "action")
      .map((node) => [
        node.id,
        {
          node,
          column: firstColumn(node),
          parents: 0,
          children: [] as string[],
        },
      ]),
  );
  for (const edge of edges) {
    const parent = slots.get(edge.to);
    const child = slots.get(edge.from);
    if (!parent || !child || child.column === 0 || parent === child) continue;
    parent.children.push(child.node.id);
    child.parents++;
  }

  const ready = [...slots.values()].filter((slot) => slot.parents === 0);
  for (const parent of ready) {
    for (const id of parent.children) {
      const child = slots.get(id)!;
      child.column = Math.max(child.column, parent.column + 1);
      if (--child.parents === 0) ready.push(child);
    }
  }
  // Mutually referring nodes still appear once, even without a topological order.
  const columns = new Map<number, MapNode[]>();
  for (const { node, column } of slots.values()) {
    const group = columns.get(column) ?? [];
    group.push(node);
    columns.set(column, group);
  }
  const firstLane = columns.get(0);
  if (firstLane) {
    const children = new Map<string, MapNode[]>();
    for (const node of firstLane) {
      const parent = leftParent.get(node.id);
      if (parent) {
        const group = children.get(parent) ?? [];
        group.push(node);
        children.set(parent, group);
      }
    }
    const ordered = new Set<MapNode>();
    function add(node: MapNode) {
      if (ordered.has(node)) return;
      ordered.add(node);
      children.get(node.id)?.forEach(add);
    }
    firstLane
      .filter((node) => node.kind === "topic" || node.kind === "question")
      .forEach(add);
    firstLane.forEach(add);
    columns.set(0, [...ordered]);
  }
  const orderedColumns = [...columns].sort(([left], [right]) => left - right);
  if (actions.length) {
    const lastLevel = orderedColumns.at(-1)?.[0] ?? 0;
    orderedColumns.push([lastLevel + 1, actions]);
  }
  return {
    columns: orderedColumns,
    rows: rowsByTopic(orderedColumns, graph.edges),
    edges,
    pendingByIdea,
    evidenceByNode,
  };
}
