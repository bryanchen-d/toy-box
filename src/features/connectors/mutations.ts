import { mutationOptions } from "@tanstack/react-query";
import { createConnector, deleteConnector, updateConnector } from "./server/functions";
import { applyConnectorListEvent, invalidateConnectorListQuery } from "./queryCache";
import type { ConnectorOptions } from "./model";

export const connectorMutations = {
  create: () =>
    mutationOptions({
      mutationFn: (input: ConnectorOptions) => createConnector({ data: input }),
      onSuccess: (_connector, _variables, _onMutateResult, { client }) =>
        invalidateConnectorListQuery(client),
    }),

  update: (connectorId: string) =>
    mutationOptions({
      mutationFn: (options: ConnectorOptions) =>
        updateConnector({ data: { connectorId, options } }),
      onSuccess: (_connector, _variables, _onMutateResult, { client }) =>
        invalidateConnectorListQuery(client),
    }),

  delete: (connectorId: string) =>
    mutationOptions({
      mutationFn: () => deleteConnector({ data: { connectorId } }),
      onSuccess: (_deleted, _variables, _onMutateResult, { client }) =>
        applyConnectorListEvent(client, { type: "connector.deleted", connectorId }),
    }),
};
