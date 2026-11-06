import { queryOptions } from "@tanstack/react-query";
import { listConnectors, listConnectorTunnels } from "./server/functions";

export const connectorQueries = {
  listKey: () => ["connectors", "list"] as const,

  list: () =>
    queryOptions({
      queryKey: connectorQueries.listKey(),
      queryFn: listConnectors,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),

  tunnels: () =>
    queryOptions({
      queryKey: ["connectors", "tunnels"] as const,
      queryFn: listConnectorTunnels,
      staleTime: 30_000,
      retry: false,
    }),
};
