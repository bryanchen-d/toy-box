import { useState } from "react";
import { Hash, Pause, Plus } from "lucide-react";
import { WorkingAgents } from "@teams/components/agents/WorkingAgents";
import { useTeams } from "@teams/useTeams";
import { SidebarListItem } from "@/shared/sidebar/SidebarListItem";
import { SidebarPanel } from "@/shared/sidebar/SidebarPanel";
import { Button } from "@/shared/ui/button";
import { RelativeTime } from "@/shared/ui/relative-time";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { SessionMetadataBadges } from "@sessions/components/location/SessionMetadataBadges";
import { TeamDialog } from "../TeamDialog";
import { TeamMenuItems } from "../TeamMenuItems";
import { teamSidebarStatus } from "./status";
import { DeleteTeamDialog } from "../DeleteTeamDialog";

export function TeamsPanel({
  isExpanded,
  onExpandedChange,
  openTeamIds,
  onTeamOpen,
  onBrowseDirectory,
  onCreate,
}: {
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  openTeamIds: string[];
  onTeamOpen: (teamId: string, toggleInWorkspace: boolean) => void;
  onBrowseDirectory: (directory: string) => void;
  onCreate: () => void;
}) {
  const teams = useTeams();
  const [editTeamId, setEditTeamId] = useState<string>();
  const [deleteTeamId, setDeleteTeamId] = useState<string>();

  const editing = teams.find(({ team }) => team.id === editTeamId)?.team;
  const deleting = teams.find(({ team }) => team.id === deleteTeamId)?.team;
  const rows = teams.map((entry) => ({
    ...entry,
    status: teamSidebarStatus(entry.team, entry.status, openTeamIds.includes(entry.team.id)),
  }));

  return (
    <>
      <SidebarPanel
        title="Teams"
        isExpanded={isExpanded}
        onExpandedChange={onExpandedChange}
        emptyMessage="Create a team of agents to work toward a purpose together."
        activity={{
          waiting: rows.some(({ status }) => status?.kind === "waiting"),
          finished: rows.some(({ status }) => status?.kind === "finished"),
          unread: rows.some(({ status }) => status?.kind === "unread"),
          running: teams.some(({ agents }) => agents.some(({ isRunning }) => isRunning)),
        }}
        action={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label="Create team"
                  onClick={onCreate}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              }
            />
            <TooltipContent sideOffset={6}>Create team</TooltipContent>
          </Tooltip>
        }
      >
        {rows.map(({ team, agents, status }) => {
          const { directory } = team;

          return (
            <SidebarListItem
              key={team.id}
              title={team.name}
              titleContent={
                <span className="flex items-center gap-3">
                  <span>{team.name}</span>
                  {team.paused && (
                    <Pause className="size-3 text-muted-foreground" aria-label="Team paused" />
                  )}
                  <WorkingAgents
                    working={agents
                      .filter(({ isRunning }) => isRunning)
                      .map((agent) => ({ agent }))}
                    variant="compact"
                  />
                </span>
              }
              icon={
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-700 dark:text-cyan-300">
                  <Hash className="size-4" />
                </span>
              }
              time={<RelativeTime date={team.updatedAt} />}
              badge={directory ? <SessionMetadataBadges cwd={directory} /> : undefined}
              menuItems={
                <TeamMenuItems
                  team={team}
                  onEdit={() => setEditTeamId(team.id)}
                  onBrowse={directory ? () => onBrowseDirectory(directory) : undefined}
                  onDelete={() => setDeleteTeamId(team.id)}
                />
              }
              status={status}
              isActive={openTeamIds.includes(team.id)}
              onClick={(event) => onTeamOpen(team.id, event.metaKey || event.ctrlKey)}
            />
          );
        })}
      </SidebarPanel>

      {editing && (
        <TeamDialog
          key={editing.id}
          team={editing}
          onOpenChange={(open) => {
            if (!open) setEditTeamId(undefined);
          }}
        />
      )}

      {deleting && (
        <DeleteTeamDialog
          team={deleting}
          onOpenChange={(open) => {
            if (!open) setDeleteTeamId(undefined);
          }}
        />
      )}
    </>
  );
}
