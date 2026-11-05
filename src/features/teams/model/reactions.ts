import type { TeamAgent, TeamConversationMessage, TeamReaction } from ".";
import type { TeamAgentPresence } from "./presence";

/** A reaction as a message shows it: recorded, or projected from a working agent's activity. */
export type TeamMessageReaction = {
  agentId: string;
  reaction: TeamReaction["reaction"] | "looking" | "working";
};

/** A message's recorded reactions, plus the working agents looking at or acting on it. */
export function teamMessageReactions(
  message: Pick<TeamConversationMessage, "sequence" | "reactions">,
  agents: readonly Pick<TeamAgent, "id" | "status">[],
  presence: Readonly<Record<string, TeamAgentPresence>>,
): TeamMessageReaction[] {
  const reactions: TeamMessageReaction[] = [...(message.reactions ?? [])];
  for (const agent of agents) {
    if (presence[agent.id]?.state !== "working" || agent.status?.state !== "working") continue;
    if (agent.status.lookingAt === message.sequence) {
      reactions.push({ agentId: agent.id, reaction: "looking" });
    }
    if (agent.status.workingOn === message.sequence) {
      reactions.push({ agentId: agent.id, reaction: "working" });
    }
  }
  return reactions;
}
