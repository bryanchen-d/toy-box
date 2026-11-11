// Connector definitions, their live links, and delivery into connectors.

import { broadcast, subscribeWorkspaceEvents } from "@workspace/server/events";
import { getStateDatabase } from "@/server/database";
import { getProcessValue, sharedMap } from "@/shared/server/processState";
import type { ConnectorEntry, ConnectorMessage, ConnectorOptions } from "../model";
import { ConnectorDatabase, type ConnectorRecord } from "./database";
import { openConnectorEndpoint } from "./devtunnel";
import { ConnectorLink } from "./link";

const DIRECTORY_SYNC_DELAY_MS = 2_000;

const links = sharedMap<ConnectorLink>("connector-links");
const published = sharedMap<string>("connector-published");
const directorySync = getProcessValue("connector-directory-sync", () => ({
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
}));

export async function listConnectors(): Promise<ConnectorEntry[]> {
  const db = await getStateDatabase({ createIfMissing: false });
  if (!db) return [];
  const database = new ConnectorDatabase(db);
  return Promise.all((await database.list()).map((record) => entryFor(database, record)));
}

export async function createConnector(options: ConnectorOptions): Promise<ConnectorEntry> {
  const database = new ConnectorDatabase(await getStateDatabase());
  const record = await database.create(options);
  startLink(database, record);
  return publish(database, record);
}

export async function updateConnector(
  connectorId: string,
  options: ConnectorOptions,
): Promise<ConnectorEntry> {
  const database = new ConnectorDatabase(await getStateDatabase());
  const record = await database.update(connectorId, options);
  if (!record) throw new Error("Connector not found.");
  await stopLink(connectorId);
  startLink(database, record);
  return publish(database, record);
}

/** Removes the connector and drops its undelivered messages. */
export async function deleteConnector(connectorId: string): Promise<boolean> {
  await stopLink(connectorId);
  const deleted = await new ConnectorDatabase(await getStateDatabase()).delete(connectorId);
  if (deleted) {
    published.delete(connectorId);
    broadcast({ type: "connector.deleted", connectorId });
  }
  return deleted;
}

/** Queues a message for a connector and delivers it as soon as the connector is reachable. */
export async function sendToConnector(
  connectorId: string,
  message: ConnectorMessage,
): Promise<void> {
  await new ConnectorDatabase(await getStateDatabase()).enqueue(connectorId, message);
  const link = links.get(connectorId);
  if (link) void link.deliver();
  else void publishConnector(connectorId);
}

/** Connects every connector for this server's lifetime. */
export async function startConnectors(): Promise<VoidFunction> {
  const unsubscribe = subscribeWorkspaceEvents((event) => {
    if (event.type === "team.upserted" || event.type === "team.deleted") scheduleDirectorySync();
  });
  // A fresh install has no connectors until one is added, which starts its own link.
  const db = await getStateDatabase({ createIfMissing: false });
  if (db) {
    const database = new ConnectorDatabase(db);
    for (const record of await database.list()) {
      // A dev reload reruns startup over the same registry, so each link replaces the last one.
      await stopLink(record.id);
      startLink(database, record);
    }
  }
  return () => {
    unsubscribe();
    clearTimeout(directorySync.timer);
    void Promise.all([...links.keys()].map(stopLink));
  };
}

function startLink(database: ConnectorDatabase, record: ConnectorRecord): void {
  const link = new ConnectorLink(record, {
    database,
    openEndpoint: openConnectorEndpoint,
    applyEvent: async (connector, event) =>
      (await import("@teams/server/connectors")).applyConnectorEvent(connector, event),
    noteUndelivered: async (connector, message, reason) =>
      (await import("@teams/server/connectors")).noteUndeliveredConnectorMessage(
        connector,
        message,
        reason,
      ),
    readDirectory: async () => (await import("@teams/server/connectors")).listConnectorDirectory(),
    onChange: (connectorId) => void publishConnector(connectorId),
  });
  links.set(record.id, link);
  link.start();
}

async function stopLink(connectorId: string): Promise<void> {
  const link = links.get(connectorId);
  links.delete(connectorId);
  await link?.stop();
}

/** Team names and purposes change often; send connectors the settled list. */
function scheduleDirectorySync(): void {
  clearTimeout(directorySync.timer);
  directorySync.timer = setTimeout(() => {
    for (const link of links.values()) void link.syncDirectory();
  }, DIRECTORY_SYNC_DELAY_MS);
  directorySync.timer.unref?.();
}

async function publishConnector(connectorId: string): Promise<void> {
  try {
    const database = new ConnectorDatabase(await getStateDatabase());
    const record = await database.get(connectorId);
    if (record) await publish(database, record);
  } catch (error) {
    console.error(`Failed to publish connector ${connectorId}:`, error);
  }
}

/** Broadcasts the connector only when what clients see of it changed. */
async function publish(database: ConnectorDatabase, record: ConnectorRecord) {
  const connector = await entryFor(database, record);
  const serialized = JSON.stringify(connector);
  if (published.get(record.id) !== serialized) {
    published.set(record.id, serialized);
    broadcast({ type: "connector.upserted", connector });
  }
  return connector;
}

async function entryFor(
  database: ConnectorDatabase,
  { clientId: _clientId, receivedThrough: _receivedThrough, ...connector }: ConnectorRecord,
): Promise<ConnectorEntry> {
  return {
    ...connector,
    status: links.get(connector.id)?.status ?? { state: "connecting", since: connector.updatedAt },
    pending: await database.countPending(connector.id),
  };
}
