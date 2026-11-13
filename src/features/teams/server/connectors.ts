// Teams' side of connectors. A message that opens by addressing a connector goes to it in its
// thread's conversation; the connector's events land back in the thread that holds that conversation.

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { agentTeamsDirectory } from "@/server/storage";
import {
  base64ByteLength,
  connectorAttachmentType,
  connectorsAddressedBy,
  CONNECTOR_ATTACHMENT_MAX_BYTES,
  CONNECTOR_ATTACHMENTS_MAX,
  CONNECTOR_MESSAGE_MAX_LENGTH,
  CONNECTOR_PROTOCOL_VERSION,
  type Connector,
  type ConnectorAttachment,
  type ConnectorEvent,
  type ConnectorMessage,
} from "@connectors/model";
import { isTeamSystemMessage, type Team } from "@teams/model";
import { getStateDatabase } from "@/server/database";
import { sharedMap } from "@/shared/server/processState";
import { TeamDatabase, type StoredAttachment, type StoredTeamMessage } from "./database";

const TEAM_MESSAGE_MAX_LENGTH = 12_000;
const EXCERPT_LENGTH = 200;
/** Agents may send one conversation this many messages an hour, so bots can't loop forever. */
const AGENT_FORWARDS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

// A fuse rather than a quota: it resets when the server restarts.
const agentForwards = sharedMap<number[]>("connector-agent-forwards");

/** Sends a user or Agent message to every connector it opens by addressing. */
export async function forwardToAddressedConnectors(
  team: Team,
  message: StoredTeamMessage,
  senderName: string,
): Promise<void> {
  if (isTeamSystemMessage(message) || message.sender.type === "connector") return;
  const { listConnectors, sendToConnector } = await import("@connectors/server");
  const mentioned = connectorsAddressedBy(message.content, await listConnectors());
  if (mentioned.length === 0) return;

  const database = new TeamDatabase(await getStateDatabase());
  // A conversation spans a thread, so a reply anywhere in it continues the same conversation.
  const threadSequence = message.threadSequence ?? message.sequence;
  const sender: ConnectorMessage["sender"] =
    message.sender.type === "agent"
      ? { kind: "agent", name: senderName }
      : { kind: "user", name: "Owner" };
  const { attachments, skipped } = await connectorAttachments(message.attachments ?? []);
  const content = `${message.content}${skipped.length ? `\n\n(Not forwarded: ${skipped.join("; ")})` : ""}`;

  await Promise.all(
    mentioned.map(async (connector) => {
      const conversationId = await database.claimConnectorConversation({
        connectorId: connector.id,
        conversationId: crypto.randomUUID(),
        teamId: team.id,
        threadSequence,
      });
      if (sender.kind === "agent" && !allowAgentForward(`${connector.id}:${conversationId}`)) {
        await noteUndelivered(database, team.id, {
          connectorId: connector.id,
          threadSequence,
          reason: "throttled",
          content: message.content,
        });
        return;
      }
      await sendToConnector(connector.id, {
        version: CONNECTOR_PROTOCOL_VERSION,
        id: message.id,
        conversationId,
        sender,
        origin: { kind: "team", teamId: team.id, teamName: team.name },
        content: content.slice(0, CONNECTOR_MESSAGE_MAX_LENGTH),
        ...(attachments.length ? { attachments } : {}),
      });
    }),
  );
}

/**
 * A message's files as a connector carries them: the supported types, up to the size and count
 * limits, read now so the queued message keeps them even if the files change. The rest are named
 * with the reason they stayed behind.
 */
async function connectorAttachments(stored: readonly StoredAttachment[]) {
  const attachments: ConnectorAttachment[] = [];
  const skipped: string[] = [];
  for (const [index, attachment] of stored.entries()) {
    const { name, mimeType, size, read } = await describeAttachment(attachment, index);
    const reason = !mimeType
      ? "not a supported type"
      : size === undefined
        ? "missing"
        : size > CONNECTOR_ATTACHMENT_MAX_BYTES
          ? "over 10 MB"
          : attachments.length >= CONNECTOR_ATTACHMENTS_MAX
            ? `over the ${CONNECTOR_ATTACHMENTS_MAX}-file limit`
            : undefined;
    if (reason || !mimeType) skipped.push(`${name}, ${reason}`);
    else attachments.push({ name, mimeType, base64: await read() });
  }
  return { attachments, skipped };
}

/** A team attachment's file name, supported type, and size, which is unknown for a missing file. */
async function describeAttachment(attachment: StoredAttachment, index: number) {
  if (typeof attachment !== "string") {
    return {
      // Uploaded images have no name of their own.
      name: `image-${index + 1}.${attachment.mimeType.split("/")[1]}`,
      mimeType: connectorAttachmentType(attachment.mimeType),
      size: base64ByteLength(attachment.base64),
      read: async () => attachment.base64,
    };
  }
  const file = Bun.file(attachment);
  return {
    name: basename(attachment),
    mimeType: connectorAttachmentType(file.type),
    size: (await file.exists()) ? file.size : undefined,
    read: async () => Buffer.from(await file.arrayBuffer()).toString("base64"),
  };
}

function allowAgentForward(key: string, now = Date.now()): boolean {
  const recent = (agentForwards.get(key) ?? []).filter((at) => now - at < HOUR_MS);
  const allowed = recent.length < AGENT_FORWARDS_PER_HOUR;
  agentForwards.set(key, allowed ? [...recent, now] : recent);
  return allowed;
}

/**
 * Posts a connector event in its conversation's thread, or starts a thread when the connector
 * addresses a team directly. Events that can never apply are dropped; anything else throws so
 * the connector replays it.
 */
export async function applyConnectorEvent(
  connector: Connector,
  event: ConnectorEvent,
): Promise<void> {
  const database = new TeamDatabase(await getStateDatabase());
  const thread = await database.getConnectorThread(connector.id, event.conversationId);
  const teamId = thread?.teamId ?? event.to?.teamId;
  if (!teamId || !(await database.getTeam(teamId))) {
    console.warn(
      `Dropping connector ${connector.name} event ${event.id}: it addresses no current team.`,
    );
    return;
  }

  const { postMessage } = await import("./index");
  const attachments = event.attachments?.length
    ? await saveEventFiles(connector.id, event.id, event.attachments)
    : undefined;
  const post = (threadSequence?: number) =>
    postMessage(
      {
        id: `${connector.id}:${event.id}`,
        teamId,
        sender: { type: "connector", connectorId: connector.id },
        content: fitTeamMessage(event.content),
        ...(attachments ? { attachments } : {}),
        ...(event.origin ? { origin: event.origin } : {}),
        ...(threadSequence === undefined ? {} : { threadSequence }),
      },
      { authorName: connector.name },
    );

  let message: StoredTeamMessage;
  try {
    message = await post(thread?.threadSequence);
  } catch (error) {
    if (isDuplicateMessage(error)) return;
    if (!(error instanceof Error) || !thread || !/^Reply to/.test(error.message)) throw error;
    // The thread is gone, so the conversation continues at the top level.
    message = await post();
  }
  if (!thread) {
    await database.claimConnectorConversation({
      connectorId: connector.id,
      conversationId: event.conversationId,
      teamId,
      threadSequence: message.sequence,
    });
  }
}

/** Tells the team that a connector never received one of its messages. */
export async function noteUndeliveredConnectorMessage(
  connector: Connector,
  message: ConnectorMessage,
  reason: "expired" | "rejected",
): Promise<void> {
  const database = new TeamDatabase(await getStateDatabase());
  const thread = await database.getConnectorThread(connector.id, message.conversationId);
  const teamId = thread?.teamId ?? message.origin.teamId;
  if (!(await database.getTeam(teamId))) return;
  await noteUndelivered(database, teamId, {
    connectorId: connector.id,
    threadSequence: thread?.threadSequence,
    reason,
    content: message.content,
  });
}

async function noteUndelivered(
  database: TeamDatabase,
  teamId: string,
  {
    connectorId,
    threadSequence,
    reason,
    content,
  }: {
    connectorId: string;
    threadSequence?: number;
    reason: "expired" | "rejected" | "throttled";
    content: string;
  },
): Promise<void> {
  const change = await database.noteConnectorUndelivered(teamId, {
    type: "connector_undelivered",
    connectorId,
    ...(threadSequence === undefined ? {} : { threadSequence }),
    reason,
    excerpt: excerpt(content),
  });
  const { publishTeamChange } = await import("./index");
  publishTeamChange(change);
}

/** The teams a connector may start a conversation with. */
export async function listConnectorDirectory() {
  const { teams } = await new TeamDatabase(await getStateDatabase()).listTeams();
  return teams.map(({ id, name, purpose }) => ({ id, name, ...(purpose ? { purpose } : {}) }));
}

/**
 * Saves an event's files where its team message can attach them by path, one folder per event so
 * a replay rewrites the same files.
 */
async function saveEventFiles(
  connectorId: string,
  eventId: string,
  attachments: readonly ConnectorAttachment[],
): Promise<string[]> {
  const directory = agentTeamsDirectory("connectors", connectorId, fileName(eventId));
  await mkdir(directory, { recursive: true });
  const used = new Set<string>();
  return Promise.all(
    attachments.map(async ({ name, base64 }, index) => {
      const safe = fileName(name);
      const path = join(directory, used.has(safe) ? `${index + 1}-${safe}` : safe);
      used.add(safe);
      await Bun.write(path, Buffer.from(base64, "base64"));
      return path;
    }),
  );
}

/** A name every platform accepts as one file name. */
function fileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_");
  return safe.slice(0, 200) || "file";
}

function fitTeamMessage(content: string): string {
  const suffix = "\n\n…(truncated)";
  return content.length <= TEAM_MESSAGE_MAX_LENGTH
    ? content
    : `${content.slice(0, TEAM_MESSAGE_MAX_LENGTH - suffix.length)}${suffix}`;
}

function excerpt(content: string): string {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length <= EXCERPT_LENGTH ? line : `${line.slice(0, EXCERPT_LENGTH - 1)}…`;
}

function isDuplicateMessage(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}
