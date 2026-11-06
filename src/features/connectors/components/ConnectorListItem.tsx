import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { RelativeTime } from "@/shared/ui/relative-time";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/shared/ui/dropdown-menu";
import { DestructiveConfirmationDialog } from "@/shared/sidebar/DestructiveConfirmationDialog";
import { SidebarListItem } from "@/shared/sidebar/SidebarListItem";
import { cn } from "@/shared/utils";
import { connectorHandle, type ConnectorEntry } from "../model";
import { connectorMutations } from "../mutations";

export function ConnectorListItem({
  connector,
  onEdit,
}: {
  connector: ConnectorEntry;
  onEdit: () => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { status, pending } = connector;
  const connected = status.state === "connected";
  const error = status.state === "connecting" ? status.error : undefined;

  return (
    <>
      <SidebarListItem
        title={connector.name}
        icon={
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              connected ? "bg-green-500" : "bg-amber-500",
            )}
          />
        }
        time={
          <span title={error}>
            {connected ? "Connected" : error ? "Offline" : "Connecting"}{" "}
            <RelativeTime date={status.since} />
          </span>
        }
        badge={pending > 0 ? <Badge variant="metadata">{pending} queued</Badge> : undefined}
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
        onClick={onEdit}
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
