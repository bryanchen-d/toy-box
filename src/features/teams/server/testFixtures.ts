import type { CreateTeamInput } from "@teams/model";
import type { Worker } from "@workers/model";
import type { TeamDatabase } from "./database";

export function teamAgent(
  teamId: string,
  sessionId: string,
  name?: string,
): Extract<Worker, { type: "team" }> {
  return {
    createdAt: new Date(0).toISOString(),
    type: "team",
    teamId,
    sessionId,
    ephemeral: false,
    name,
    metadata: { seenThrough: 0 },
  };
}

/** Persist a Team fixture without starting its provider. */
export function createStoredTeam(database: TeamDatabase, input: CreateTeamInput) {
  const teamId = crypto.randomUUID();
  return database.createTeam(input, teamAgent(teamId, teamId));
}
