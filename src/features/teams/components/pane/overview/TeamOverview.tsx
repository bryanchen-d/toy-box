import { useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Hash, MoreHorizontal, PanelRightClose, Pin, PinOff } from "lucide-react";
import { AgentEditor } from "@teams/components/agents/AgentEditor";
import { TeamDialog } from "@teams/components/TeamDialog";
import { TeamMenuItems } from "@teams/components/TeamMenuItems";
import { DeleteTeamDialog } from "@teams/components/DeleteTeamDialog";
import type { Team, TeamArtifact, TeamMember, TeamRoutine } from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { FileBrowserDialog } from "@files/components/browser/FileBrowserDialog";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import type { PaneVariant } from "@workspace/components/panes/shell/WorkspacePaneView";
import { PaneActions } from "@workspace/components/panes/shell/PaneSlots";
import {
  PANE_OVERLAY_BUTTON_CLASS,
  PANE_OVERLAY_ICON_CLASS,
} from "@workspace/components/panes/shell/paneControls";
import { Button } from "@/shared/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/shared/ui/sheet";
import { DestructiveConfirmationDialog } from "@/shared/sidebar/DestructiveConfirmationDialog";
import { useTeamPane } from "../TeamPaneContext";
import { TeamOverviewContent } from "./TeamOverviewContent";

const OVERVIEW_WIDTH = 320;

/** Closed, open over the transcript as a sheet, or pinned beside it, which the layout remembers. */
type OverviewPresentation = "closed" | "sheet" | "pinned";

type OverviewDialog =
  | { type: "edit_team" | "delete_team" | "browse_directory" }
  | { type: "edit_member" | "remove_member"; member: TeamMember };

/** The Team's current purpose, progress, shared work, and roster. */
export function TeamOverview({
  team,
  artifacts,
  routines,
  variant,
  actions,
  allowPin = true,
}: {
  team: Team;
  artifacts: TeamArtifact[];
  routines: TeamRoutine[];
  variant: PaneVariant;
  /** The pane's other actions, which precede the overview's trigger and give way to it when pinned. */
  actions?: ReactNode;
  allowPin?: boolean;
}) {
  const { openFile, teamOverviewPinned = false, setTeamOverviewPinned } = useWorkspaceSurface();
  const { mention, openArtifact: revealArtifact, openArtifacts, openMembers } = useTeamPane();
  const overviewRef = useRef<HTMLDivElement>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [dialog, setDialog] = useState<OverviewDialog>();
  const canPin = variant === "normal" && allowPin;
  const isPinned = canPin && teamOverviewPinned;
  const openLabel = `Open #${team.name} overview`;
  const trigger = canPin ? (
    <button
      type="button"
      aria-label={openLabel}
      title={openLabel}
      className={PANE_OVERLAY_BUTTON_CLASS}
    >
      <Hash className={PANE_OVERLAY_ICON_CLASS} />
    </button>
  ) : (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={openLabel} title={openLabel}>
      <Hash />
    </Button>
  );

  function present(presentation: OverviewPresentation) {
    setTeamOverviewPinned?.(presentation === "pinned");
    setIsSheetOpen(presentation === "sheet");
  }

  // Acting from the sheet dismisses it, while a pinned rail stays put.
  function closeSheet() {
    setIsSheetOpen(false);
  }

  function openArtifact(artifact: TeamArtifact) {
    closeSheet();
    revealArtifact(artifact.file);
  }

  function openDialog(next: OverviewDialog) {
    closeSheet();
    setDialog(next);
  }

  function onDialogOpenChange(open: boolean) {
    if (!open) setDialog(undefined);
  }

  const browseDirectory = () => openDialog({ type: "browse_directory" });

  const teamMenu = (
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
          onEdit={() => openDialog({ type: "edit_team" })}
          onBrowse={team.directory ? browseDirectory : undefined}
          onDelete={() => openDialog({ type: "delete_team" })}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const overviewContent = (
    <TeamOverviewContent
      team={team}
      artifacts={artifacts}
      routines={routines}
      onArtifactOpen={openArtifact}
      onManageArtifacts={() => {
        closeSheet();
        openArtifacts();
      }}
      onViewMembers={() => {
        closeSheet();
        openMembers();
      }}
      onEditMember={(member) => openDialog({ type: "edit_member", member })}
      onRemoveMember={(member) => openDialog({ type: "remove_member", member })}
      onAddAgent={() => {
        closeSheet();
        mention();
      }}
      onBrowseDirectory={browseDirectory}
      onPreviewOpen={closeSheet}
    />
  );

  return (
    <>
      <PaneActions>
        {!isPinned && (
          <>
            {actions}
            <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
              <SheetTrigger render={trigger} />
              <SheetContent
                ref={overviewRef}
                initialFocus={overviewRef}
                showCloseButton={false}
                style={canPin ? { width: OVERVIEW_WIDTH } : undefined}
                className="w-[92%] gap-0 overflow-hidden p-0 sm:max-w-md"
              >
                <OverviewHeader
                  title={<SheetTitle>{team.name}</SheetTitle>}
                  menu={teamMenu}
                  canPin={canPin}
                  isPinned={isPinned}
                  onPresent={present}
                />
                {overviewContent}
              </SheetContent>
            </Sheet>
          </>
        )}
      </PaneActions>

      {/* Closing animates the rail. Switching to the Sheet replaces it immediately. */}
      {!isSheetOpen && (
        <AnimatePresence>
          {isPinned && (
            <m.aside
              key="team-overview"
              aria-label={`#${team.name} overview`}
              style={{ width: OVERVIEW_WIDTH }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="col-start-2 row-span-2 row-start-1 min-h-0 overflow-hidden"
            >
              <div
                className="flex h-full flex-col border-l bg-background"
                style={{ width: OVERVIEW_WIDTH }}
              >
                <OverviewHeader
                  title={<h2 className="font-semibold text-foreground">{team.name}</h2>}
                  menu={teamMenu}
                  canPin={canPin}
                  isPinned={isPinned}
                  onPresent={present}
                />
                {overviewContent}
              </div>
            </m.aside>
          )}
        </AnimatePresence>
      )}

      {dialog?.type === "edit_team" && (
        <TeamDialog key={team.id} team={team} onOpenChange={onDialogOpenChange} />
      )}
      {dialog?.type === "edit_member" && (
        <AgentEditor agent={dialog.member} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.type === "delete_team" && (
        <DeleteTeamDialog team={team} onOpenChange={onDialogOpenChange} />
      )}
      {dialog?.type === "browse_directory" && (
        <FileBrowserDialog
          open
          onOpenChange={onDialogOpenChange}
          title="Open a file"
          initialPath={team.directory}
          onOpenFile={openFile}
        />
      )}
      {dialog?.type === "remove_member" && (
        <DestructiveConfirmationDialog
          key={dialog.member.id}
          title={`Remove ${dialog.member.name}?`}
          description={`This removes ${dialog.member.name} from #${team.name} and deletes their private team session. Their messages and reactions remain attributed to Deleted agent.`}
          confirmLabel="Remove"
          pendingLabel="Removing…"
          mutation={teamMutations.removeMember(dialog.member.id)}
          onOpenChange={onDialogOpenChange}
        />
      )}
    </>
  );
}

/** The title and actions, the same whether the overview is a sheet or pinned. */
function OverviewHeader({
  title,
  menu,
  canPin,
  isPinned,
  onPresent,
}: {
  title: ReactNode;
  menu: ReactNode;
  canPin: boolean;
  isPinned: boolean;
  onPresent: (presentation: OverviewPresentation) => void;
}) {
  const pinLabel = isPinned ? "Unpin overview" : "Pin overview";

  return (
    <div className="flex items-center gap-2 border-b px-2.5 py-3">
      <div className="min-w-0 flex-1">{title}</div>
      <div className="flex shrink-0 items-center">
        {menu}
        {canPin && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={pinLabel}
            title={pinLabel}
            // Unpinning keeps the overview open, as a sheet.
            onClick={() => onPresent(isPinned ? "sheet" : "pinned")}
          >
            {isPinned ? <PinOff /> : <Pin />}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close overview"
          title="Close overview"
          onClick={() => onPresent("closed")}
        >
          <PanelRightClose />
        </Button>
      </div>
    </div>
  );
}
