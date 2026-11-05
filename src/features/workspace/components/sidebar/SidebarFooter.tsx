import type { ReactNode } from "react";
import { BrowseMenu, HyperButton, TerminalToggle } from "./SidebarActions";

export function SidebarFooter({
  leadingSlot,
  onBrowseFiles,
  onBrowseScreens,
  onToggleHyper,
  isHyperOpen,
  onToggleTerminal,
  isTerminalOpen,
}: {
  /** The row's first item: an action that survives collapse, or a spacer holding its place. */
  leadingSlot?: ReactNode;
  onBrowseFiles: () => void;
  onBrowseScreens: () => void;
  onToggleHyper: () => void;
  isHyperOpen: boolean;
  onToggleTerminal: () => void;
  isTerminalOpen: boolean;
}) {
  return (
    <div className="pt-3 md:pb-3 px-2.5 border-t flex items-center justify-between">
      <div className="flex items-center gap-2">{leadingSlot}</div>
      <div className="flex items-center gap-3">
        <HyperButton onToggle={onToggleHyper} isOpen={isHyperOpen} />
        <BrowseMenu onBrowseFiles={onBrowseFiles} onBrowseScreens={onBrowseScreens} side="top" />
        <TerminalToggle isTerminalOpen={isTerminalOpen} onToggleTerminal={onToggleTerminal} />
      </div>
    </div>
  );
}
