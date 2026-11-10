import type {
  DiscussionGraph,
  MapEdge,
  MapNode,
} from "../../discussion-map/types";

export type MapRecording = {
  script: string;
  run: string;
  model: string;
  promptVersion: string;
  steps: (DiscussionGraph & {
    throughUtteranceId: string;
    removedEdgeIds: string[];
  })[];
};

export function vertexGraphAt(
  recording: MapRecording,
  index: number,
): DiscussionGraph {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  for (const step of recording.steps.slice(0, index + 1)) {
    for (const node of step.nodes) nodes.set(node.id, node);
    for (const id of step.removedEdgeIds) edges.delete(id);
    for (const edge of step.edges) edges.set(edge.id, edge);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
