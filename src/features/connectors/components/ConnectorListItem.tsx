import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { RelativeTime } from "@/shared/ui/relative-time";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/shared/ui/dropdown-menu";
import { DestructiveConfirmationDialog } from "@/shared/sidebar/DestructiveConfirmationDialog";
import { SidebarListItem } from "@/shared/sidebar/SidebarListItem";
import { cn } from "@/shared/utils";
import { useNodeSubSessions } from "@workers/components/SubSessions";
import { connectorHandle, poolNodes, type ConnectorEntry } from "../model";
import { connectorMutations } from "../mutations";

export function ConnectorListItem({
  connector,
  onOpen,
  onEdit,
}: {
  connector: ConnectorEntry;
  /** Opens what the connector shows when clicked: a pool's use, or a service's settings. */
  onOpen: () => void;
  onEdit: () => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { status, pending } = connector;
  const connected = status.state === "connected";
  const unreachable = status.state === "unreachable";
  const error = status.state === "connected" ? undefined : status.error;
  const working = useNodeSubSessions(poolNodes(connector).map(({ name }) => name)).filter(
    (subSession) => subSession.working,
  ).length;

  return (
    <>
      <SidebarListItem
        title={connector.name}
        icon={
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              connected ? "bg-green-500" : unreachable ? "bg-destructive" : "bg-amber-500",
            )}
          />
        }
        time={
          <span title={error} className={cn(unreachable && "text-destructive")}>
            {connected
              ? "Connected"
              : unreachable
                ? "Unreachable"
                : error
                  ? "Offline"
                  : "Connecting"}{" "}
            <RelativeTime date={status.since} />
          </span>
        }
        badge={
          pending > 0 ? (
            <Badge variant="metadata">{pending} queued</Badge>
          ) : working > 0 ? (
            <Badge variant="metadata">{working} working</Badge>
          ) : undefined
        }
        menuItems={
          <>
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
              Edit connector
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete connector
            </DropdownMenuItem>
          </>
        }
        onClick={onOpen}
        aria-label={`${connector.name}, mention as @${connectorHandle(connector)}`}
      />
      {deleteOpen && (
        <DestructiveConfirmationDialog
          title="Delete connector?"
          description={`Teams can no longer reach ${connector.name}.${pending === 0 ? "" : pending === 1 ? " Its 1 queued message is dropped." : ` Its ${pending} queued messages are dropped.`}`}
          mutation={connectorMutations.delete(connector.id)}
          onOpenChange={(open) => {
            if (!open) setDeleteOpen(false);
          }}
        />
      )}
    </>
  );
}
