// Teams addressing one another. The user or a lead opens a message with another team's handle to
// reach that team's lead. Each conversation spans one thread on either side, so a reply that opens
// with the sender team's handle returns to the thread it came from.

import {
  addressableTeams,
  isTeamSystemMessage,
  teamsAddressedBy,
  type Team,
  type TeamAgent,
} from "@teams/model";
import { getStateDatabase } from "@/server/database";
import { sharedMap } from "@/shared/server/processState";
import { TeamDatabase, type StoredTeamMessage } from "./database";

/** A lead may send another team this many messages an hour, so two leads can't loop forever. */
const LEAD_MESSAGES_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

// A fuse rather than a quota: it resets when the server restarts.
const leadMessages = sharedMap<number[]>("team-peer-lead-messages");

/** The other teams a message written in this team opens by addressing. */
export async function teamsAddressedFrom(
  teamId: string,
  content: string,
  agents: readonly TeamAgent[],
): Promise<Team[]> {
  if (!/^\s*@/.test(content)) return [];
  const { listConnectors } = await import("@connectors/server");
  const [{ teams }, connectors] = await Promise.all([
    new TeamDatabase(await getStateDatabase()).listTeams(),
    listConnectors(),
  ]);
  return teamsAddressedBy(content, addressableTeams(teams, { teamId, agents, connectors }));
}

/** Only a lead speaks for its team, within the hourly fuse for each team it addresses. */
export function admitAgentTeamMessage(
  agent: { id: string; teamId: string },
  targets: readonly Team[],
  now = Date.now(),
): void {
  if (targets.length === 0) return;
  if (agent.id !== agent.teamId) {
    throw new Error("Only your lead can message another team. Mention @lead to ask it.");
  }
  for (const target of targets) {
    const key = `${agent.teamId}:${target.id}`;
    const recent = (leadMessages.get(key) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= LEAD_MESSAGES_PER_HOUR) {
      throw new Error(
        `You've sent ${target.name} ${LEAD_MESSAGES_PER_HOUR} messages in the last hour. Wait before sending more.`,
      );
    }
    leadMessages.set(key, [...recent, now]);
  }
}

/**
 * Posts a user or lead message into each team it opens by addressing, in the thread that holds
 * this thread's conversation with that team, linking a new one when there is none yet.
 */
export async function forwardToAddressedTeams(
  team: Team,
  message: StoredTeamMessage,
  agents: readonly TeamAgent[],
): Promise<void> {
  if (isTeamSystemMessage(message)) return;
  const { sender } = message;
  const by =
    sender.type === "user"
      ? "user"
      : sender.type === "agent" && sender.agentId === team.id
        ? "lead"
        : undefined;
  if (!by) return;
  const targets = await teamsAddressedFrom(team.id, message.content, agents);
  if (targets.length === 0) return;

  const database = new TeamDatabase(await getStateDatabase());
  const { postMessage } = await import("./index");
  const threadSequence = message.threadSequence ?? message.sequence;
  await Promise.all(
    targets.map(async (target) => {
      const peerThread = await database.getPeerThread(team.id, threadSequence, target.id);
      const posted = await postMessage(
        {
          // Derived from the original, so forwarding the same message twice posts it once.
          id: `${message.id}:${target.id}`,
          teamId: target.id,
          sender: { type: "team", teamId: team.id, by },
          content: message.content,
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(peerThread === null ? {} : { threadSequence: peerThread }),
        },
        { authorName: by === "lead" ? `${team.name}'s lead` : `the user, from ${team.name}` },
      );
      if (peerThread === null) {
        await database.linkPeerThreads(team.id, threadSequence, target.id, posted.sequence);
      }
    }),
  );
}
