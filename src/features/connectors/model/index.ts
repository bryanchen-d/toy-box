import { z } from "zod";
import { agentHandleFromName, leadingMentionHandles } from "@teams/model/agent";

/** The wire contract's version. Every request body and event carries it. */
export const CONNECTOR_PROTOCOL_VERSION = 1;

/** Undelivered messages in either direction are dropped this long after they were created. */
export const CONNECTOR_MESSAGE_TTL_MS = 5 * 24 * 60 * 60 * 1000;

/** The longest message a connector accepts. */
export const CONNECTOR_MESSAGE_MAX_LENGTH = 20_000;

const connectorIdSchema = z.string().trim().min(1).max(255);
const connectorNameSchema = z.string().trim().min(1).max(80);

/** How Agent Teams reaches a connector. It always dials out; a connector never dials in. */
export const connectorTransportSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("http"),
      url: z.url({ protocol: /^https?$/ }).describe("The connector's base URL"),
    })
    .strict(),
  z
    .object({
      type: z.literal("devtunnel"),
      tunnelId: z.string().trim().min(1).max(200),
      port: z.number().int().min(1).max(65_535),
    })
    .strict(),
]);
export type ConnectorTransport = z.output<typeof connectorTransportSchema>;

export const connectorOptionsSchema = z
  .object({ name: connectorNameSchema, transport: connectorTransportSchema })
  .strict();
export type ConnectorOptions = z.output<typeof connectorOptionsSchema>;

/** An app-level link to one external service that every team can talk to. */
export type Connector = ConnectorOptions & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

/** Live connection state. It is never persisted: every server start begins connecting. */
export type ConnectorStatus =
  | { state: "connected"; since: string }
  | { state: "connecting"; since: string; error?: string };

/** A connector with its live status and the count of messages waiting to be delivered to it. */
export type ConnectorEntry = Connector & { status: ConnectorStatus; pending: number };

export const connectorIdInputSchema = z.object({ connectorId: connectorIdSchema }).strict();

export const updateConnectorInputSchema = connectorOptionsSchema.extend({
  connectorId: connectorIdSchema,
});

/** The @handle that addresses a connector, derived by the same grammar as agent mentions. */
export function connectorHandle(connector: Pick<Connector, "name">): string {
  return agentHandleFromName(connector.name);
}

/**
 * The connectors a message opens by addressing, which each receive it. Elsewhere in the text a
 * connector's handle is only its name, so talking about one never sends it anything.
 */
export function connectorsAddressedBy<C extends Pick<Connector, "name">>(
  content: string,
  connectors: readonly C[],
): C[] {
  const handles = leadingMentionHandles(content);
  return connectors.filter((connector) => handles.includes(connectorHandle(connector)));
}

/** Where forwarded content came from. A requester who isn't the owner speaks only as context. */
export const connectorOriginSchema = z.object({
  kind: z.string().trim().min(1).max(50),
  permalink: z.url().max(2_000).optional(),
  channel: z.string().max(200).optional(),
  requester: z
    .object({
      id: z.string().max(200),
      name: z.string().max(200).optional(),
      isOwner: z.boolean(),
    })
    .optional(),
});
export type ConnectorOrigin = z.output<typeof connectorOriginSchema>;

/** One event a connector streams to Agent Teams. Every kind presents the same way here. */
export const connectorEventSchema = z.object({
  version: z.literal(CONNECTOR_PROTOCOL_VERSION),
  id: connectorIdSchema,
  conversationId: connectorIdSchema,
  content: z.string().trim().min(1),
  origin: connectorOriginSchema.nullish(),
  to: z.object({ teamId: connectorIdSchema }).nullish(),
});
export type ConnectorEvent = z.output<typeof connectorEventSchema>;

/** One message Agent Teams sends to a connector. */
export type ConnectorMessage = {
  version: typeof CONNECTOR_PROTOCOL_VERSION;
  id: string;
  conversationId: string;
  sender: { kind: "user" | "agent"; name: string };
  origin: { kind: "team"; teamId: string; teamName: string };
  content: string;
};

/** Exponential backoff with ±20% jitter, so reconnecting clients don't arrive in lockstep. */
export function backoffDelay(
  failures: number,
  { min, max }: { min: number; max: number },
  random: () => number = Math.random,
): number {
  const base = Math.min(max, min * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Delivery retries back off from 5 seconds to 5 minutes. */
export const DELIVERY_BACKOFF = { min: 5_000, max: 5 * 60_000 };

/** Stream reconnects back off from 1 second to 1 minute. */
export const RECONNECT_BACKOFF = { min: 1_000, max: 60_000 };
