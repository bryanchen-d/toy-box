import type { ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { inboxQueries } from "@inbox/queries";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/utils";
import { useWorkspaceSelector } from "@workspace/hooks/state";

/**
 * The sidebar's top row, whose one destination is the Inbox. The app's name is
 * left to the browser tab or the installed app's title bar, which already show it.
 * On desktop the row is as tall as a pane's header, so their rules meet in one line.
 */
export function SidebarHeader({
  leadingSlot,
  onOpenInbox,
  isInboxOpen,
}: {
  /** The row's first item: an action that survives collapse, or a spacer holding its place. */
  leadingSlot?: ReactNode;
  onOpenInbox: () => void;
  isInboxOpen: boolean;
}) {
  const { data: inboxEntries } = useSuspenseQuery(inboxQueries.list());
  const hasUnreadInbox = useWorkspaceSelector((workspace) =>
    inboxEntries.some((entry) => workspace.sessionStates[entry.id]?.status === "unread"),
  );
  const showInboxUnreadIndicator = !isInboxOpen && hasUnreadInbox;

  return (
    <div className="pt-0 pb-3 md:py-1 px-2.5 border-b flex items-center gap-2">
      {leadingSlot}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onOpenInbox}
        aria-current={isInboxOpen ? "page" : undefined}
        aria-label={showInboxUnreadIndicator ? "Inbox, unread activity" : "Inbox"}
        className={cn("min-w-0 flex-1 justify-start px-2", isInboxOpen && "bg-muted")}
      >
        <Inbox />
        Inbox
        {showInboxUnreadIndicator && (
          <span className="ml-auto size-1.5 rounded-full bg-unread" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
