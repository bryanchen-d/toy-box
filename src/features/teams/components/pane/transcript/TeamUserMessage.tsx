import { MessageSquareReply } from "lucide-react";
import { AgentMentionMarkdown } from "@teams/components/agents/AgentMentionMarkdown";
import { type TeamConversationMessage } from "@teams/model";
import { UserMessage } from "@/shared/messages/UserMessage";
import { Button } from "@/shared/ui/button";
import { ClockTime } from "@/shared/ui/clock-time";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { useTeamPane } from "../TeamPaneContext";
import { TeamReactions } from "./TeamReactions";
import { ThreadSummary } from "./ThreadReplies";
import type { TranscriptThread } from "./transcriptRows";
import { CopyTeamUri } from "@teams/components/CopyTeamUri";
import { cn } from "@/shared/utils";

/** The user's message, shown as in a session, with the reactions agents gave it and its thread. */
export function TeamUserMessage({
  message,
  thread,
}: {
  message: TeamConversationMessage;
  thread?: TranscriptThread;
}) {
  const { teamId, selectedMessageSequence, replyInThread, isSending } = useTeamPane();

  return (
    <div
      className={cn(
        "flex flex-col",
        selectedMessageSequence === message.sequence && "rounded-lg ring-2 ring-primary/40",
      )}
      data-message-sequence={message.sequence}
    >
      <UserMessage
        message={message}
        time={<ClockTime className="text-xs text-muted-foreground" date={message.timestamp} />}
        extraActions={
          <>
            <TeamReactions message={message} className="mr-1" />
            {!isSending(message.id) && (
              <CopyTeamUri
                variant="button"
                target={{ type: "message", teamId, sequence: message.sequence }}
                label="Copy message URI"
              />
            )}
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
