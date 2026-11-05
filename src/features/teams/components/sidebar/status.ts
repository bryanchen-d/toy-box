import type { Team, teamStatus } from "@teams/model";

/** Requests remain visible while a Team is open; other attention is acknowledged by viewing it. */
export function teamSidebarStatus(
  team: Team,
  status: ReturnType<typeof teamStatus>,
  isOpen: boolean,
) {
  if (status === "waiting")
    return {
      kind: "waiting" as const,
      ariaLabel: `${team.name} needs your attention`,
      tooltip: "Waiting for your response",
    };
  if (isOpen) return;
  if (status === "finished")
    return {
      kind: "finished" as const,
      ariaLabel: `${team.name} completed its tasks`,
      tooltip: "All tasks completed",
    };
  if (status === "unread")
    return {
      kind: "unread" as const,
      ariaLabel: `${team.name} has unread messages`,
      tooltip: "Team has unread messages",
    };
}
