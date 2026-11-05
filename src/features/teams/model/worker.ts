// Interpret opaque Worker metadata as Team identity and collaboration state.
import type { Worker } from "@workers/model";
import { teamAgentMetadataSchema, teamLead, compareTeamAgents, type TeamMember } from "./index";

export function isTeamLead(worker: Extract<Worker, { type: "team" }>): boolean {
  return worker.sessionId === worker.teamId;
}

export function teamAgentFromWorker(worker: Extract<Worker, { type: "team" }>) {
  const metadata = teamAgentMetadataSchema.parse(worker.metadata);
  const context = { teamId: worker.teamId, seenThrough: metadata.seenThrough };
  return isTeamLead(worker)
    ? { ...teamLead(worker.sessionId, metadata.status), ...context, isLead: true as const }
    : { ...teamMemberFromWorker(worker, metadata), ...context, isLead: false as const };
}

export type TeamAgentContext = ReturnType<typeof teamAgentFromWorker>;

export function teamRoster(workers: Extract<Worker, { type: "team" }>[]) {
  const lead = workers.find(isTeamLead);
  if (!lead) throw new Error("Team lead is incomplete.");
  return {
    lead: teamLead(lead.sessionId, teamAgentMetadataSchema.parse(lead.metadata).status),
    members: teamMembersFromWorkers(workers),
  };
}

export function teamMembersFromWorkers(workers: Extract<Worker, { type: "team" }>[]) {
  return workers
    .filter((worker) => !isTeamLead(worker))
    .map((worker) => teamMemberFromWorker(worker))
    .sort(compareTeamAgents);
}

export function teamMemberFromWorker(
  worker: Extract<Worker, { type: "team" }>,
  metadata = teamAgentMetadataSchema.parse(worker.metadata),
): TeamMember {
  if (!worker.name) throw new Error("Team members require a name.");
  const { seenThrough: _seenThrough, ...profile } = metadata;
  return { teamId: worker.teamId, id: worker.sessionId, name: worker.name, ...profile };
}
