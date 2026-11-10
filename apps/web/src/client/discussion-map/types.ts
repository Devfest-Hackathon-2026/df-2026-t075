export type Utterance = { id: string; speaker: string; text: string };

export type MapReaction = "agree" | "disagree";
export type EvidenceRelation = "supports" | "opposes" | "informs";

type ResearchSource = { publisher: string; title: string; href: string };
export type MapResearch = { question: string; retryId?: string } & (
  | { state: "looking" }
  | {
      state: "answered";
      answer: string;
      source: ResearchSource;
    }
  | { state: "unverified" | "failed"; answer: string; source?: ResearchSource }
);

export type MapNode = {
  id: string;
  kind:
    "topic" | "question" | "idea" | "reason" | "condition" | "note" | "action";
  text: string;
  // AI can supply a published answer without being a speaker in the transcript.
  reportedBy?: "AI";
  // An action can be assigned by someone other than the person doing it.
  assignee?: string;
  research?: MapResearch;
  status?:
    | "open"
    | "candidate"
    | "checking"
    | "confirmed"
    | "proposed-removal"
    | "excluded"
    | "relaxed"
    | "withdrawn"
    | "decided"
    | "pending"
    | "completed";
  // The first source introduces the item; the others can be earlier context or later updates.
  sourceUtteranceIds: string[];
  sourceRoles?: Record<string, "statement" | MapReaction>;
};

export type MapEdge = {
  id: string;
  from: string;
  to: string;
  relation:
    | "answers"
    | EvidenceRelation
    | "condition_for"
    | "action_for"
    | "asks_about"
    | "reason_for_exclusion"
    | "revises_condition"
    | "cites";
};

export type DiscussionGraph = { nodes: MapNode[]; edges: MapEdge[] };

export function isEvidenceRelation(
  relation: MapEdge["relation"],
): relation is EvidenceRelation {
  return (
    relation === "supports" || relation === "opposes" || relation === "informs"
  );
}
