// A withdrawal is recent activity. Participants polling the room see the reason
// briefly, including when no one edits the plan again.
export function proposalNotice(
  id: string,
  status: string,
  planVersion: number,
  now: number,
) {
  return { id, status, planVersion, expiresAt: now + 30_000 };
}

export type ProposalNotice = ReturnType<typeof proposalNotice>;
