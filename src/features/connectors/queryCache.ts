import type { QueryClient } from "@tanstack/react-query";
import type { WorkspaceEvent } from "@workspace/model/events";
import type { ConnectorEntry } from "./model";
import { connectorQueries } from "./queries";

export function applyConnectorListEvent(queryClient: QueryClient, event: WorkspaceEvent): void {
  switch (event.type) {
    case "connector.upserted":
      queryClient.setQueryData<ConnectorEntry[]>(connectorQueries.listKey(), (list) =>
        list
          ? [...list.filter(({ id }) => id !== event.connector.id), event.connector].sort(
              (left, right) =>
                left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
                left.id.localeCompare(right.id),
            )
          : list,
      );
      break;
    case "connector.deleted":
      queryClient.setQueryData<ConnectorEntry[]>(connectorQueries.listKey(), (list) =>
        list?.filter(({ id }) => id !== event.connectorId),
      );
      break;
    default:
      return;
  }
  // Replace an overlapping snapshot with a read started after the committed change.
  if (queryClient.getQueryState(connectorQueries.listKey())?.fetchStatus === "fetching") {
    void queryClient.refetchQueries({ queryKey: connectorQueries.listKey(), exact: true });
  }
}

export function invalidateConnectorListQuery(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: connectorQueries.listKey(), exact: true });
}
