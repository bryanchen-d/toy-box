import { useTeams } from "@teams/useTeams";
import { SidebarStatusMark, type SidebarStatus } from "@/shared/sidebar/SidebarStatus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";
import { teamSidebarStatus } from "./status";

/** The collapsed sidebar's Teams: one vertical tab each, named, to switch between them at a glance. */
export function TeamTabs({
  openTeamIds,
  onTeamOpen,
}: {
  openTeamIds: string[];
  onTeamOpen: (teamId: string, toggleInWorkspace: boolean) => void;
}) {
  const teams = useTeams();
  if (teams.length === 0) return null;

  return (
    <ul aria-label="Teams" className="flex flex-col items-center gap-2 py-1.5">
      {teams.map(({ team, agents, status }) => {
        const isOpen = openTeamIds.includes(team.id);
        const mark: SidebarStatus | undefined =
          teamSidebarStatus(team, status, isOpen) ??
          (agents.some(({ isRunning }) => isRunning)
            ? { kind: "running", ariaLabel: `${team.name} is working`, tooltip: "Working" }
            : undefined);
        const description = [team.name, team.paused && "Paused", mark?.tooltip]
          .filter(Boolean)
          .join(" · ");

        return (
          <li key={team.id}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={description}
                    aria-current={isOpen ? "true" : undefined}
                    onClick={(event) => onTeamOpen(team.id, event.metaKey || event.ctrlKey)}
                    className={cn(
                      "relative flex w-7 cursor-pointer justify-center rounded-lg py-2.5 text-xs font-medium text-cyan-700 transition-colors dark:text-cyan-300",
                      isOpen
                        ? "bg-cyan-500/30 ring-2 ring-cyan-500/60"
                        : "bg-cyan-500/15 hover:bg-cyan-500/25",
                    )}
                  >
                    <span className="max-h-56 truncate [writing-mode:vertical-rl]">
                      {team.name}
                    </span>
                    {mark && (
                      <span
                        aria-hidden
                        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-background *:scale-75"
                      >
                        <SidebarStatusMark kind={mark.kind} />
                      </span>
                    )}
                  </button>
                }
              />
              <TooltipContent side="right" sideOffset={8}>
                {description}
              </TooltipContent>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
