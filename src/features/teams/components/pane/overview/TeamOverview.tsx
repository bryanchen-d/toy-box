import { useState } from "react";
import { Hash, MoreHorizontal } from "lucide-react";
import { TeamDialog } from "@teams/components/TeamDialog";
import { TeamMenuItems } from "@teams/components/TeamMenuItems";
import { DeleteTeamDialog } from "@teams/components/DeleteTeamDialog";
import type { Team, TeamArtifact, TeamRoutine } from "@teams/model";
import { FileBrowserDialog } from "@files/components/browser/FileBrowserDialog";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { Button } from "@/shared/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { TeamPanelHeader } from "../TeamPanelHeader";
import { TeamOverviewContent } from "./TeamOverviewContent";

type OverviewDialog = "edit_team" | "delete_team" | "browse_directory";

/** The Team's purpose and setting, with a summary of each of its other panels. */
export function TeamOverview({
  team,
  artifacts,
  routines,
}: {
  team: Team;
  artifacts: TeamArtifact[];
  routines: TeamRoutine[];
}) {
  const { openFile } = useWorkspaceSurface();
  const [dialog, setDialog] = useState<OverviewDialog>();

  function onDialogOpenChange(open: boolean) {
    if (!open) setDialog(undefined);
  }

  const browseDirectory = () => setDialog("browse_directory");

  return (
    <section
      aria-label={`#${team.name} overview`}
      className="flex h-full min-h-0 min-w-0 flex-col bg-panel"
    >
      <TeamPanelHeader icon={Hash} title={team.name}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Team actions"
                title="Team actions"
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <TeamMenuItems
              team={team}
              onEdit={() => setDialog("edit_team")}
              onBrowse={team.directory ? browseDirectory : undefined}
              onDelete={() => setDialog("delete_team")}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TeamPanelHeader>
      <TeamOverviewContent
        team={team}
        artifacts={artifacts}
        routines={routines}
        onBrowseDirectory={browseDirectory}
      />

      {dialog === "edit_team" && (
        <TeamDialog key={team.id} team={team} onOpenChange={onDialogOpenChange} />
      )}
      {dialog === "delete_team" && (
        <DeleteTeamDialog team={team} onOpenChange={onDialogOpenChange} />
      )}
      {dialog === "browse_directory" && (
        <FileBrowserDialog
          open
          onOpenChange={onDialogOpenChange}
          title="Open a file"
          initialPath={team.directory}
          onOpenFile={openFile}
        />
      )}
    </section>
  );
}
