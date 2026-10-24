import { MessageSquareReply } from "lucide-react";
import { AgentMentionMarkdown } from "@channels/components/agents/AgentMentionMarkdown";
import { type ChannelConversationMessage } from "@channels/model";
import { UserMessage } from "@/shared/messages/UserMessage";
import { Button } from "@/shared/ui/button";
import { ClockTime } from "@/shared/ui/clock-time";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { useChannelPane } from "../ChannelPaneContext";
import { ChannelReactions } from "./ChannelReactions";
import { ThreadSummary } from "./ThreadReplies";
import type { TranscriptThread } from "./transcriptRows";

/** The user's message, shown as in a session, with the reactions agents gave it and its thread. */
export function ChannelUserMessage({
  message,
  thread,
}: {
  message: ChannelConversationMessage;
  thread?: TranscriptThread;
}) {
  const { replyInThread, isSending } = useChannelPane();

  return (
    <div className="flex flex-col">
      <UserMessage
        message={message}
        time={<ClockTime className="text-xs text-muted-foreground" date={message.timestamp} />}
        extraActions={
          <>
            <ChannelReactions message={message} className="mr-1" />
            {!isSending(message.id) && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Reply in thread"
                      onClick={() => replyInThread(message)}
                    >
                      <MessageSquareReply aria-hidden />
                    </Button>
                  }
                />
                <TooltipContent sideOffset={4}>Reply in thread</TooltipContent>
              </Tooltip>
            )}
          </>
        }
      >
        <AgentMentionMarkdown content={message.content} onAccent />
      </UserMessage>
      {thread && <ThreadSummary thread={thread} className="-mr-1.5 self-end" />}
    </div>
  );
}
