import { useSuspenseQuery } from "@tanstack/react-query";
import { useWorkspaceSelector } from "@workspace/hooks/state";
import { teamLead, teamStatus } from "./model";
import { teamQueries } from "./queries";

/** The shared catalog plus live team activity, derived from the existing workspace cache. */
export function useTeams() {
  const {
    data: { teams, members },
  } = useSuspenseQuery(teamQueries.list());

  return useWorkspaceSelector((workspace) =>
    teams.map((team) => ({
      team,
      agents: [teamLead(team.id), ...members.filter(({ teamId }) => teamId === team.id)].map(
        (agent) => ({
          ...agent,
          isRunning: workspace.sessionStates[agent.id]?.status === "running",
        }),
      ),
      status: teamStatus(team),
    })),
  );
}
