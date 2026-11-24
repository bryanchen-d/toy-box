import type { ReactNode } from "react";
import { useWorkspaceSelector } from "@workspace/hooks/state";
import { Separator } from "@/shared/ui/separator";
import {
  ActionSpacer,
  BrowseMenu,
  HyperButton,
  SidebarSplitButton,
  TerminalToggle,
  type SessionCreationOptions,
} from "./SidebarActions";
import { SIDEBAR_COLLAPSED_WIDTH } from "./SidebarResizer";
import { cn } from "@/shared/utils";

/** The rail's separators are the footer's vertical rule turned on its side. */
const SEPARATOR = "my-1.5 h-px! w-4! bg-muted-foreground/50!";

/**
 * The collapsed desktop sidebar: the header and footer rows turned on their side
 * inside a bar one action wide, so the session list gives up its space without
 * taking the sidebar's common actions with it. With the section headers out of
 * reach, it also carries their create actions. Between them, `children` holds
 * what stays reachable while collapsed, scrolling when it outgrows the bar.
 *
 * `Sidebar` pins the collapse toggle and settings actions outside both layouts,
 * so this stack opens and closes with the shapes those actions occupy when
 * expanded, leaving each pin a hole to land in rather than measuring around it.
 */
export function SidebarRail({
  collapsed,
  className,
  onCreateSession,
  onCreateAutomation,
  onCreateTeam,
  onBrowseFiles,
  onBrowseScreens,
  onToggleHyper,
  isHyperOpen,
  onToggleTerminal,
  isTerminalOpen,
  children,
}: {
  collapsed: boolean;
  className?: string;
  onCreateSession: (options?: SessionCreationOptions) => void;
  onCreateAutomation: () => void;
  onCreateTeam: () => void;
  onBrowseFiles: () => void;
  onBrowseScreens: () => void;
  onToggleHyper: () => void;
  isHyperOpen: boolean;
  onToggleTerminal: () => void;
  isTerminalOpen: boolean;
  children?: ReactNode;
}) {
  const showSidebarTools = useWorkspaceSelector((workspace) => workspace.settings.showSidebarTools);

  return (
    <div
      aria-hidden={!collapsed}
      inert={!collapsed}
      // The rail holds the collapsed sidebar's width rather than filling it, so
      // its icons sit on their final pixel from the first frame of a collapse
      // instead of sliding inward as the sidebar narrows.
      style={{ width: SIDEBAR_COLLAPSED_WIDTH }}
      className={cn(
        "absolute inset-y-0 left-0 flex flex-col items-center gap-3 pt-2 pb-3 bg-background",
        className,
      )}
    >
      {/*
        The pinned collapse toggle centers in the header's row, which puts it
        this top inset down; the stack then measures from the action itself,
        exactly as the foot does above the settings hole.
      */}
      <ActionSpacer />
      <Separator className={SEPARATOR} />
      <SidebarSplitButton
        onCreateSession={onCreateSession}
        onCreateAutomation={onCreateAutomation}
        onCreateTeam={onCreateTeam}
      />

      <div className="no-scrollbar -my-1.5 flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto">
        {children}
      </div>

      {showSidebarTools && (
        <>
          <HyperButton onToggle={onToggleHyper} isOpen={isHyperOpen} />
          <BrowseMenu
            onBrowseFiles={onBrowseFiles}
            onBrowseScreens={onBrowseScreens}
            side="right"
          />
          <TerminalToggle isTerminalOpen={isTerminalOpen} onToggleTerminal={onToggleTerminal} />
        </>
      )}
      <Separator className={SEPARATOR} />
      <ActionSpacer />
    </div>
  );
}
