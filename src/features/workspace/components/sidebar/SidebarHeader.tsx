import type { ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { inboxQueries } from "@inbox/queries";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { useWorkspaceSelector } from "@workspace/hooks/state";
import { SidebarSplitButton, type SessionCreationOptions } from "./SidebarActions";

const APP_TITLE = import.meta.env.VITE_APP_TITLE;

export function SidebarHeader({
  leadingSlot,
  onOpenInbox,
  isInboxOpen,
  onCreateSession,
  onCreateAutomation,
  onCreateTeam,
}: {
  /** The row's first item: an action that survives collapse, or a spacer holding its place. */
  leadingSlot?: ReactNode;
  onOpenInbox: () => void;
  isInboxOpen: boolean;
  onCreateSession: (options?: SessionCreationOptions) => void;
  onCreateAutomation: () => void;
  onCreateTeam: () => void;
}) {
  const { data: inboxEntries } = useSuspenseQuery(inboxQueries.list());
  const hasUnreadInbox = useWorkspaceSelector((workspace) =>
    inboxEntries.some((entry) => workspace.sessionStates[entry.id]?.status === "unread"),
  );
  const showInboxUnreadIndicator = !isInboxOpen && hasUnreadInbox;

  return (
    <div className="pt-0 md:pt-3 pb-3 px-2.5 border-b flex items-center gap-2">
      {leadingSlot}
      <div className="flex min-w-0 flex-1 px-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onOpenInbox}
                className="relative leading-8 font-bold text-foreground transition-colors hover:text-primary"
                aria-label={
                  showInboxUnreadIndicator ? `${APP_TITLE}, unread inbox activity` : APP_TITLE
                }
              >
                {APP_TITLE}
                {showInboxUnreadIndicator && (
                  <span
                    className="absolute -right-1 top-2 h-1.5 w-1.5 rounded-full bg-unread"
                    aria-hidden="true"
                  />
                )}
              </button>
            }
          />
          <TooltipContent sideOffset={6}>Open inbox</TooltipContent>
        </Tooltip>
      </div>
      <SidebarSplitButton
        onCreateSession={onCreateSession}
        onCreateAutomation={onCreateAutomation}
        onCreateTeam={onCreateTeam}
      />
    </div>
  );
}
