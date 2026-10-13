import { AgentAvatar } from "@channels/components/agents/AgentAvatar";
import type { ChannelConversationMessage } from "@channels/model";
import { channelMessageReactions, type ChannelMessageReaction } from "@channels/model/reactions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";
import { useChannelPane } from "../ChannelPaneContext";

const REACTION_PRESENTATION = {
  looking: { emoji: "👀", label: "Looking" },
  working: { emoji: "🏃", label: "In progress" },
  done: { emoji: "✅", label: "Done" },
  agree: { emoji: "👍", label: "Agreed" },
  celebrate: { emoji: "🎉", label: "Celebrated" },
  love: { emoji: "❤️", label: "Loved this" },
  laugh: { emoji: "😂", label: "Laughed" },
} satisfies Record<ChannelMessageReaction["reaction"], { emoji: string; label: string }>;

// A few reactors show by face; the rest count, and every name is a hover away.
const VISIBLE_REACTORS = 3;

/** The reactions agents gave a message, and the working agents looking at or acting on it. */
export function ChannelReactions({
  message,
  className,
}: {
  message: ChannelConversationMessage;
  className?: string;
}) {
  const { agents, agent, presence } = useChannelPane();
  const reactions = channelMessageReactions(message, agents, presence);
  if (reactions.length === 0) return null;
  const groups = new Map<ChannelMessageReaction["reaction"], ChannelMessageReaction[]>();
  for (const reaction of reactions) {
    groups.set(reaction.reaction, [...(groups.get(reaction.reaction) ?? []), reaction]);
  }

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {[...groups].map(([reaction, entries]) => {
        const presentation = REACTION_PRESENTATION[reaction];
        const reactors = entries.map(({ agentId }) => agent(agentId));
        const names = reactors.map(({ name }) => name).join(", ");
        return (
          <Tooltip key={reaction}>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={`${presentation.label}: ${names}`}
                  className="inline-flex h-5.5 items-center gap-1 rounded-full border bg-muted/40 pr-1 pl-1.5 text-2xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <span aria-hidden>{presentation.emoji}</span>
              <span className="flex gap-0.5">
                {reactors.slice(0, VISIBLE_REACTORS).map((reactor) => (
                  <AgentAvatar key={reactor.id} agent={reactor} className="size-3.5" />
                ))}
              </span>
              {reactors.length > VISIBLE_REACTORS && (
                <span className="tabular-nums">+{reactors.length - VISIBLE_REACTORS}</span>
              )}
            </TooltipTrigger>
            <TooltipContent sideOffset={4} className="max-w-72">
              {names}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
