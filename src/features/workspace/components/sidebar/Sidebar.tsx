import { useState } from "react";
import { AutomationPanel } from "@automations/components/AutomationPanel";
import { AutomationDialog } from "@automations/components/AutomationDialog";
import { cn } from "@/shared/utils";
import type { Session } from "@sessions/model";
import type { SessionFilters } from "@sessions/components/sidebar/sessionFilters";
import { AppsPanel } from "@apps/components/AppsPanel";
import { SettingsDialog } from "./SettingsDialog";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarRail } from "./SidebarRail";
import { SidebarResizer, type SidebarCollapseControl } from "./SidebarResizer";
import {
  ActionSpacer,
  CollapseToggle,
  SettingsButton,
  type SessionCreationOptions,
} from "./SidebarActions";
import { SessionList } from "@sessions/components/sidebar/SessionList";
import { SessionFilterInput } from "@sessions/components/sidebar/SessionFilterInput";
import { SidebarSection } from "@/shared/sidebar/SidebarSection";
import { FileBrowserDialog } from "@files/components/browser/FileBrowserDialog";
import { ScreenBrowserDialog } from "@screens/client/ScreenBrowserDialog";
import { TeamsPanel } from "@teams/components/sidebar/TeamsPanel";
import { TeamDialog } from "@teams/components/TeamDialog";
import type { SidebarPanel, SidebarPanels } from "@workspace/model/config/layoutPrefs";

/**
 * Crossfade one of the sidebar's two layouts. Whichever layout is leaving clears
 * out quickly, so the narrowing sidebar never shows squeezed content, and the
 * arriving one lands as the width settles.
 */
function layerClass(visible: boolean): string {
  return cn(
    "transition-opacity ease-out motion-reduce:transition-none",
    visible ? "opacity-100 delay-150 duration-200" : "pointer-events-none opacity-0 duration-100",
  );
}

export type SidebarProps = {
  filter: SessionFilters;
  onFilterChange: (value: SessionFilters) => void;

  sessions: Session[];
  isSessionsLoading: boolean;
  onSessionSelect: (sessionId: string, toggleInWorkspace: boolean) => void;
  onSessionRename: (sessionId: string) => void;
  onSessionDelete: (sessionId: string) => void;
  openSessionIds: string[];
  worktreeSessionIds: string[];
  emptyMessage?: string;

  panels: SidebarPanels;
  onPanelExpanded: (panel: SidebarPanel, expanded: boolean) => void;

  onCreateSession: (options?: SessionCreationOptions) => void;
  openAppIds: string[];
  onAppOpen: (appId: string, toggleInWorkspace: boolean) => void;
  onAppOpenInHyper: (appId: string) => void;
  openTeamIds: string[];
  onTeamOpen: (teamId: string, toggleInWorkspace: boolean) => void;
  onToggleHyper: () => void;
  isHyperOpen: boolean;
  onOpenInbox: () => void;
  isInboxOpen: boolean;

  /**
   * Desktop only, and the presence of this is what makes the sidebar
   * collapsible. The sidebar owns how it resizes and collapses; the layout above
   * only holds the resulting width and chooses whether this is a sidebar that
   * collapses at all.
   */
  collapsible?: SidebarCollapseControl;

  onToggleTerminal: () => void;
  isTerminalOpen: boolean;

  onOpenFile: (path: string) => void;
  onOpenScreen: (screenId: string) => Promise<void>;

  className?: string;
};

/**
 * The sidebar presents two layouts over one origin: the expanded rows and, on
 * desktop, the collapsed rail. They crossfade rather than swap, and the collapse
 * toggle and settings actions are pinned outside both so the two states share
 * their exact position and the morph reads as content leaving, not chrome
 * moving. The pinned actions replace nothing on mobile, where the sidebar is the
 * whole screen and never collapses.
 */
export function Sidebar({
  filter,
  onFilterChange,

  sessions,
  isSessionsLoading,
  onSessionSelect,
  onSessionRename,
  onSessionDelete,
  openSessionIds,
  worktreeSessionIds,
  emptyMessage,

  panels,
  onPanelExpanded,

  onCreateSession,
  openAppIds,
  onAppOpen,
  onAppOpenInHyper,
  openTeamIds,
  onTeamOpen,
  onToggleHyper,
  isHyperOpen,
  onOpenInbox,
  isInboxOpen,

  collapsible,
  onToggleTerminal,
  isTerminalOpen,
  onOpenFile,
  onOpenScreen,
  className,
}: SidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The file browser opens at a row's directory, or wherever it defaults from the footer.
  const [browsing, setBrowsing] = useState<{ directory?: string }>();
  const [browsingScreens, setBrowsingScreens] = useState(false);
  const [createAutomationOpen, setCreateAutomationOpen] = useState(false);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);

  const creationActions = {
    onCreateSession,
    onCreateAutomation: () => setCreateAutomationOpen(true),
    onCreateTeam: () => setCreateTeamOpen(true),
  };

  // Only a collapsible sidebar pins the collapse toggle and settings actions
  // outside its two layouts, and only it has a rail for them to head and foot.
  const collapsed = collapsible?.collapsed ?? false;

  /*
    The sidebar clips its two layouts; it is never a scroll port. `clip` rather
    than `hidden` keeps it out of `scrollIntoView`'s ancestor walk, so revealing
    a session row in the expanded layout can never scroll the collapsed rail and
    its pinned actions out of view.
  */
  const body = (
    <div className={cn("relative h-full min-w-0 overflow-clip bg-background", className)}>
      {collapsible && (
        <div
          // Pinned to the same inset the header and footer rows pad to, and
          // centered in the same row height the header's controls set, so the
          // toggle lands on one pixel in both layouts.
          className="absolute top-3 left-2.5 z-10 flex h-8 items-center"
        >
          <CollapseToggle
            collapsed={collapsed}
            onToggle={() => collapsible.onCollapsedChange(!collapsed)}
          />
        </div>
      )}

      <div
        aria-hidden={collapsed}
        inert={collapsed}
        className={cn(
          "absolute inset-y-0 left-0 grid w-[var(--sidebar-width,100%)] grid-rows-[auto_1fr_auto] overflow-clip",
          layerClass(!collapsed),
        )}
      >
        <SidebarHeader
          leadingSlot={collapsible ? <ActionSpacer /> : undefined}
          onOpenInbox={onOpenInbox}
          isInboxOpen={isInboxOpen}
          {...creationActions}
        />

        <div className="min-h-0 min-w-0 flex flex-col bg-panel">
          <TeamsPanel
            isExpanded={panels.teams}
            onExpandedChange={(expanded) => onPanelExpanded("teams", expanded)}
            openTeamIds={openTeamIds}
            onTeamOpen={onTeamOpen}
            onBrowseDirectory={(directory) => setBrowsing({ directory })}
            onCreate={() => setCreateTeamOpen(true)}
          />

          <SidebarSection
            title="Sessions"
            count={sessions.length}
            isExpanded={panels.sessions}
            onExpandedChange={(expanded) => onPanelExpanded("sessions", expanded)}
            fill
          >
            <div className="px-3 pt-2">
              <SessionFilterInput filter={filter} onFilterChange={onFilterChange} />
            </div>
            <SessionList
              className="px-3 py-2"
              sessions={sessions}
              isLoading={isSessionsLoading}
              onSessionSelect={onSessionSelect}
              onSessionRename={onSessionRename}
              onSessionDelete={onSessionDelete}
              onBrowseDirectory={(directory) => setBrowsing({ directory })}
              openSessionIds={openSessionIds}
              worktreeSessionIds={worktreeSessionIds}
              emptyMessage={emptyMessage}
            />
          </SidebarSection>

          <AppsPanel
            isExpanded={panels.apps}
            onExpandedChange={(expanded) => onPanelExpanded("apps", expanded)}
            openAppIds={openAppIds}
            onAppOpen={onAppOpen}
            onAppOpenInHyper={onAppOpenInHyper}
          />

          <AutomationPanel
            isExpanded={panels.automations}
            onExpandedChange={(expanded) => onPanelExpanded("automations", expanded)}
            openSessionIds={openSessionIds}
            onSessionOpen={(sessionId) => onSessionSelect(sessionId, false)}
            onCreate={() => setCreateAutomationOpen(true)}
          />
        </div>

        <SidebarFooter
          leadingSlot={
            collapsible ? (
              <ActionSpacer />
            ) : (
              <SettingsButton onOpenSettings={() => setSettingsOpen(true)} />
            )
          }
          onBrowseFiles={() => setBrowsing({})}
          onBrowseScreens={() => setBrowsingScreens(true)}
          onToggleHyper={onToggleHyper}
          isHyperOpen={isHyperOpen}
          onToggleTerminal={onToggleTerminal}
          isTerminalOpen={isTerminalOpen}
        />
      </div>

      {collapsible && (
        <SidebarRail
          collapsed={collapsed}
          className={layerClass(collapsed)}
          {...creationActions}
          onBrowseFiles={() => setBrowsing({})}
          onBrowseScreens={() => setBrowsingScreens(true)}
          onToggleHyper={onToggleHyper}
          isHyperOpen={isHyperOpen}
          onToggleTerminal={onToggleTerminal}
          isTerminalOpen={isTerminalOpen}
        />
      )}

      {collapsible && (
        <div className="absolute bottom-3 left-2.5 z-10 flex">
          <SettingsButton onOpenSettings={() => setSettingsOpen(true)} />
        </div>
      )}
    </div>
  );

  return (
    <>
      {collapsible ? <SidebarResizer {...collapsible}>{body}</SidebarResizer> : body}

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <FileBrowserDialog
        open={browsing !== undefined}
        onOpenChange={(open) => {
          if (!open) setBrowsing(undefined);
        }}
        initialPath={browsing?.directory}
        title="Open a file"
        onOpenFile={onOpenFile}
      />
      <ScreenBrowserDialog
        open={browsingScreens}
        onOpenChange={setBrowsingScreens}
        onOpenScreen={onOpenScreen}
      />

      {createAutomationOpen && <AutomationDialog onOpenChange={setCreateAutomationOpen} />}

      {createTeamOpen && (
        <TeamDialog
          onOpenChange={setCreateTeamOpen}
          onCreated={(teamId) => onTeamOpen(teamId, false)}
        />
      )}
    </>
  );
}
