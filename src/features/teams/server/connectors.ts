// Teams' side of connectors. Mentioning a connector sends it the message in its thread's
// conversation; the connector's events land back in the thread that holds that conversation.

import {
  connectorsMentionedIn,
  CONNECTOR_MESSAGE_MAX_LENGTH,
  CONNECTOR_PROTOCOL_VERSION,
  type Connector,
  type ConnectorEvent,
  type ConnectorMessage,
} from "@connectors/model";
import { isTeamSystemMessage, type Team } from "@teams/model";
import { getStateDatabase } from "@/server/database";
import { sharedMap } from "@/shared/server/processState";
import { TeamDatabase, type StoredTeamMessage } from "./database";

const TEAM_MESSAGE_MAX_LENGTH = 12_000;
const EXCERPT_LENGTH = 200;
/** Agents may send one conversation this many messages an hour, so bots can't loop forever. */
const AGENT_FORWARDS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

// A fuse rather than a quota: it resets when the server restarts.
const agentForwards = sharedMap<number[]>("connector-agent-forwards");

/** Sends a user or Agent message to every connector it mentions. */
export async function forwardMentionsToConnectors(
  team: Team,
  message: StoredTeamMessage,
  senderName: string,
): Promise<void> {
  if (isTeamSystemMessage(message) || message.sender.type === "connector") return;
  const { listConnectors, sendToConnector } = await import("@connectors/server");
  const mentioned = connectorsMentionedIn(message.content, await listConnectors());
  if (mentioned.length === 0) return;

  const database = new TeamDatabase(await getStateDatabase());
  // A conversation spans a thread, so a reply anywhere in it continues the same conversation.
  const threadSequence = message.threadSequence ?? message.sequence;
  const sender: ConnectorMessage["sender"] =
    message.sender.type === "agent"
      ? { kind: "agent", name: senderName }
      : { kind: "user", name: "Owner" };
  const omitted = message.attachments?.length ?? 0;
  const content = `${message.content}${omitted ? `\n\n(${omitted} attachment${omitted === 1 ? "" : "s"} not forwarded)` : ""}`;

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
      });
    }),
  );
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
  const post = (threadSequence?: number) =>
    postMessage(
      {
        id: `${connector.id}:${event.id}`,
        teamId,
        sender: { type: "connector", connectorId: connector.id },
        content: fitTeamMessage(event.content),
        ...(event.origin ? { origin: event.origin } : {}),
        ...(threadSequence === undefined ? {} : { threadSequence }),
      },
      { connectorName: connector.name },
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
