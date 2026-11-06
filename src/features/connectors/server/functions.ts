// Connector catalog and validated commands for UI clients.

import { createServerFn } from "@tanstack/react-start";
import { zodValidator } from "@tanstack/zod-adapter";
import {
  connectorIdInputSchema,
  connectorOptionsSchema,
  updateConnectorInputSchema,
} from "../model";
import * as lifecycle from "./index";

export const listConnectors = createServerFn({ method: "GET" }).handler(() =>
  lifecycle.listConnectors(),
);

export const createConnector = createServerFn({ method: "POST" })
  .validator(zodValidator(connectorOptionsSchema))
  .handler(({ data }) => lifecycle.createConnector(data));

export const updateConnector = createServerFn({ method: "POST" })
  .validator(zodValidator(updateConnectorInputSchema))
  .handler(({ data }) => {
    const { connectorId, ...options } = data;
    return lifecycle.updateConnector(connectorId, options);
  });

export const deleteConnector = createServerFn({ method: "POST" })
  .validator(zodValidator(connectorIdInputSchema))
  .handler(({ data }) => lifecycle.deleteConnector(data.connectorId));

/** Tagged dev tunnels the logged-in devtunnel account owns, for the add-connector picker. */
export const listConnectorTunnels = createServerFn({ method: "GET" }).handler(async () => {
  const { listConnectorTunnels } = await import("./devtunnel");
  return listConnectorTunnels();
});
