import {
  AGENT_MENTION_TRIGGER,
  agentHandleFromName,
  agentMatchesMentionQuery,
  type AgentAvatar,
  type ChannelLead,
  type ChannelMember,
} from "@channels/model";
import type {
  CompletionItem,
  CompletionSource,
} from "@/shared/composers/completions/useCompletions";

/** A mention choice whose value is the `@handle` inserted into the draft. */
export type AgentCompletionItem = CompletionItem & {
  avatar?: AgentAvatar;
  agent?: ChannelMember;
  kind?: "everyone" | "create";
};

export function agentCompletionSource({
  lead,
  members,
  createMember,
}: {
  lead: ChannelLead;
  members: readonly ChannelMember[];
  /** Creates a member named by an unknown handle, resolving to the created member. */
  createMember: (name: string) => Promise<{ name: string }>;
}): CompletionSource<AgentCompletionItem> {
  return {
    id: "agent",
    trigger: AGENT_MENTION_TRIGGER,
    empty: "Type a name to create a member.",
    query: (text) => agentItems(text.toLowerCase(), lead, members),
    accept: (item) =>
      item.kind === "create"
        ? createMember(item.label).then(({ name }) => `@${agentHandleFromName(name)}`)
        : item.value,
  };
}

/** Everyone, the lead, then matching members; an unknown handle offers to create that member. */
function agentItems(
  query: string,
  lead: ChannelLead,
  members: readonly ChannelMember[],
): AgentCompletionItem[] {
  const items: AgentCompletionItem[] = [];
  if ("everyone".includes(query)) {
    items.push({
      value: "@everyone",
      label: "Everyone",
      description: "Wake everyone in the channel",
      group: "Channel",
      kind: "everyone",
    });
  }
  if (agentMatchesMentionQuery(lead, query)) {
    items.push({
      value: `@${agentHandleFromName(lead.name)}`,
      label: lead.name,
      description: lead.role,
      group: "Channel",
      avatar: lead.avatar,
    });
  }
  for (const agent of members
    .filter((agent) => agentMatchesMentionQuery(agent, query))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    items.push({
      value: `@${agentHandleFromName(agent.name)}`,
      label: agent.name,
      description: agent.role ?? "Onboarding",
      group: "In this channel",
      ...(agent.avatar ? { avatar: agent.avatar } : {}),
      agent,
    });
  }
  const words = query.split("-").filter(Boolean);
  if (words.length && !items.some(({ value }) => value === `@${query}`)) {
    items.push({
      value: `@${query}`,
      label: words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "),
      description: "Create and onboard through this conversation",
      group: "New member",
      kind: "create",
    });
  }
  return items;
}
