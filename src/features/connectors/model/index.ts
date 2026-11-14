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

const connectorPathSchema = z.string().trim().min(1).max(1_000);

/** A machine whose VS Code agent host runs a pool's remote sessions. */
export const poolNodeSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** How Agent Teams reaches the node's agent host. */
    transport: connectorTransportSchema,
    /** A file on this machine holding the host's connection token, read on each connection. */
    tokenFile: connectorPathSchema,
    /** Repositories checked out on the node, where sessions for teams working in them start. */
    workspaces: z
      .array(
        z
          .object({
            repository: z
              .string()
              .trim()
              .regex(/^[\w.-]+\/[\w.-]+$/, "A repository is owner/name"),
            folder: connectorPathSchema,
          })
          .strict(),
      )
      .max(20),
    /** Where sessions start for teams whose repository the node doesn't hold. */
    scratchFolder: connectorPathSchema,
    /** How many sessions may run a turn at once. */
    computeSlots: z.number().int().min(1).max(9_999),
    /** A draining node finishes its sessions but takes no new ones. */
    draining: z.boolean(),
  })
  .strict();
export type PoolNode = z.output<typeof poolNodeSchema>;

const serviceDefinitionSchema = z
  .object({ kind: z.literal("service"), transport: connectorTransportSchema })
  .strict();
const agentPoolDefinitionSchema = z
  .object({
    kind: z.literal("agentPool"),
    nodes: z
      .array(poolNodeSchema)
      .min(1)
      .max(20)
      .refine(
        (nodes) => new Set(nodes.map(({ name }) => name.toLowerCase())).size === nodes.length,
        "Each node needs its own name",
      ),
  })
  .strict();

/**
 * What a connector is: a service that serves the connector protocol, or a pool of agent nodes
 * whose remote sessions Agent Teams drives itself.
 */
export const connectorDefinitionSchema = z.discriminatedUnion("kind", [
  serviceDefinitionSchema,
  agentPoolDefinitionSchema,
]);
export type ConnectorDefinition = z.output<typeof connectorDefinitionSchema>;

export const connectorOptionsSchema = z.discriminatedUnion("kind", [
  serviceDefinitionSchema.extend({ name: connectorNameSchema }),
  agentPoolDefinitionSchema.extend({ name: connectorNameSchema }),
]);
export type ConnectorOptions = z.output<typeof connectorOptionsSchema>;

/** An app-level link to one external service that every team can talk to. */
export type Connector = ConnectorOptions & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Live connection state. It is never persisted: every server start begins connecting. A link that
 * stays out of reach for 15 minutes is unreachable, since the moment it lost the connector, until
 * it reconnects.
 */
export type ConnectorStatus =
  | { state: "connected"; since: string }
  | { state: "connecting" | "unreachable"; since: string; error?: string };

/** A connector with its live status and the count of messages waiting to be delivered to it. */
export type ConnectorEntry = Connector & { status: ConnectorStatus; pending: number };

export const connectorIdInputSchema = z.object({ connectorId: connectorIdSchema }).strict();

export const updateConnectorInputSchema = z
  .object({ connectorId: connectorIdSchema, options: connectorOptionsSchema })
  .strict();

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

/** The file types either side can show or read; anything else stays behind with a note. */
export const CONNECTOR_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/markdown",
  "text/plain",
  "application/pdf",
] as const;
export const CONNECTOR_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CONNECTOR_ATTACHMENTS_MAX = 4;

/** The supported file type a MIME type names, ignoring parameters such as a charset. */
export function connectorAttachmentType(
  mimeType: string,
): (typeof CONNECTOR_ATTACHMENT_TYPES)[number] | undefined {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  return CONNECTOR_ATTACHMENT_TYPES.find((supported) => supported === type);
}

/** The decoded size of base64 data, without decoding it. */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** A file carried inline with a message or event. Its name is a file name, never a path. */
export const connectorAttachmentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => !/[\\/]/.test(name) && name !== "." && name !== "..", "Not a file name"),
  mimeType: z.string().transform((type, context) => {
    const supported = connectorAttachmentType(type);
    if (!supported) context.addIssue({ code: "custom", message: `Unsupported file type ${type}` });
    return supported ?? z.NEVER;
  }),
  base64: z
    .base64()
    .refine((data) => base64ByteLength(data) <= CONNECTOR_ATTACHMENT_MAX_BYTES, "Over 10 MB"),
});
export type ConnectorAttachment = z.output<typeof connectorAttachmentSchema>;

const connectorAttachmentsSchema = z
  .array(connectorAttachmentSchema)
  .max(CONNECTOR_ATTACHMENTS_MAX);

/** One event a connector streams to Agent Teams. Every kind presents the same way here. */
export const connectorEventSchema = z.object({
  version: z.literal(CONNECTOR_PROTOCOL_VERSION),
  id: connectorIdSchema,
  conversationId: connectorIdSchema,
  content: z.string().trim().min(1),
  origin: connectorOriginSchema.nullish(),
  to: z.object({ teamId: connectorIdSchema }).nullish(),
  /** The ID of the message this event answers, whose agent author it wakes. */
  replyTo: connectorIdSchema.nullish(),
  attachments: connectorAttachmentsSchema.optional(),
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
  attachments?: ConnectorAttachment[];
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
