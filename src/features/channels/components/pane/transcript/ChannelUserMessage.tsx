import { AgentMentionMarkdown } from "@channels/components/agents/AgentMentionMarkdown";
import { type ChannelConversationMessage } from "@channels/model";
import { UserMessage } from "@/shared/messages/UserMessage";
import { ClockTime } from "@/shared/ui/clock-time";
import { ChannelReactions } from "./ChannelReactions";

/** The user's message, shown as in a session, with the reactions agents gave it. */
export function ChannelUserMessage({ message }: { message: ChannelConversationMessage }) {
  return (
    <UserMessage
      message={message}
      time={<ClockTime className="text-xs text-muted-foreground" date={message.timestamp} />}
      extraActions={<ChannelReactions message={message} className="mr-1" />}
    >
      <AgentMentionMarkdown content={message.content} onAccent />
    </UserMessage>
  );
}
