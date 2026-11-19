import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { SidebarPanel } from "@/shared/sidebar/SidebarPanel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { connectorQueries } from "../queries";
import { ConnectorDialog } from "./ConnectorDialog";
import { ConnectorListItem } from "./ConnectorListItem";
import { PoolDialog } from "./PoolDialog";

/** App-level connectors that every team can talk to, with their live connection status. A pool's
 *  row opens its use; a service's opens its settings. */
export function ConnectorPanel({
  isExpanded,
  onExpandedChange,
}: {
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { data: connectors } = useSuspenseQuery(connectorQueries.list());
  // undefined: closed; null: adding; an ID: editing that connector.
  const [dialog, setDialog] = useState<string | null>();
  // The pool whose use is showing.
  const [poolId, setPoolId] = useState<string>();
  const editing = connectors.find(({ id }) => id === dialog);
  const pool = connectors.find(({ id }) => id === poolId);

  return (
    <>
      <SidebarPanel
        title="Connectors"
        isExpanded={isExpanded}
        onExpandedChange={onExpandedChange}
        // An unreachable connector needs the user to restore it, even while the section is folded.
        activity={{ waiting: connectors.some(({ status }) => status.state === "unreachable") }}
        emptyMessage="Connect an outside service, like a chat bot, or a pool of agent nodes that every team can talk to."
        action={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label="Add connector"
                  onClick={() => setDialog(null)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              }
            />
            <TooltipContent sideOffset={6}>Add connector</TooltipContent>
          </Tooltip>
        }
      >
        {connectors.map((connector) => (
          <ConnectorListItem
            key={connector.id}
            connector={connector}
            onOpen={() =>
              connector.kind === "agentPool" ? setPoolId(connector.id) : setDialog(connector.id)
            }
            onEdit={() => setDialog(connector.id)}
          />
        ))}
      </SidebarPanel>

      {pool && (
        <PoolDialog
          key={pool.id}
          connector={pool}
          onEdit={() => {
            setPoolId(undefined);
            setDialog(pool.id);
          }}
          onOpenChange={(open) => {
            if (!open) setPoolId(undefined);
          }}
        />
      )}

      {(dialog === null || editing) && (
        <ConnectorDialog
          key={editing?.id ?? "new"}
          connector={editing}
          onOpenChange={(open) => {
            if (!open) setDialog(undefined);
          }}
        />
      )}
    </>
  );
}
