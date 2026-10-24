import { CornerDownRight, UserRound } from "lucide-react";
import { AgentAvatar } from "@channels/components/agents/AgentAvatar";
import type { ChannelConversationMessage } from "@channels/model";
import { ClockTime } from "@/shared/ui/clock-time";
import { cn } from "@/shared/utils";
import { useChannelPane } from "../ChannelPaneContext";
import { RequestTag } from "./RequestTag";
import { threadParticipants, type TranscriptThread } from "./transcriptRows";

// A few participants show by face; the count says the rest.
const VISIBLE_PARTICIPANTS = 3;

/** Under a message that starts a thread: who replied, how often, and when last. */
export function ThreadSummary({
  thread,
  className,
}: {
  thread: TranscriptThread;
  className?: string;
}) {
  const { openThread } = useChannelPane();
  const latest = thread.replies.at(-1)!;

  return (
    <button
      type="button"
      onClick={() => openThread(thread.sequence)}
      className={cn(
        "group/thread inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <ThreadParticipants replies={thread.replies} />
      <span className="shrink-0 font-medium group-hover/thread:underline">
        {replyCount(thread.replies.length)}
      </span>
      <span className="truncate text-muted-foreground">
        Last reply <ClockTime date={latest.timestamp} />
      </span>
      {thread.request && <RequestTag state={thread.request} />}
    </button>
  );
}

/**
 * Replies that arrived after other messages separated them from their thread, shown where they
 * arrived so new replies stay in view, with the thread's top-level message for context.
 */
export function ThreadActivity({
  thread,
  root,
}: {
  thread: TranscriptThread;
  root?: ChannelConversationMessage;
}) {
  const { agent, openThread } = useChannelPane();
  const latest = thread.replies.at(-1)!;
  const author = latest.sender.type === "agent" ? agent(latest.sender.agentId).name : "You";

  return (
    <button
      type="button"
      onClick={() => openThread(thread.sequence)}
      className="group/thread flex w-full min-w-0 gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center">
        <CornerDownRight className="size-4 text-muted-foreground" />
      </span>
      <span className="block min-w-0 flex-1 space-y-1 rounded-xl border border-dashed px-3 py-2 group-hover/thread:bg-muted/50 @md:max-w-[80%]">
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <ThreadParticipants replies={thread.replies} />
          <span className="shrink-0 font-semibold group-hover/thread:underline">
            {replyCount(thread.replies.length)} in thread
          </span>
          {root && (
            <span className="min-w-0 truncate text-muted-foreground">
              on “{messageExcerpt(root)}”
            </span>
          )}
          <ClockTime
            className="ml-auto shrink-0 text-2xs text-muted-foreground"
            date={latest.timestamp}
          />
          {thread.request && <RequestTag state={thread.request} />}
        </span>
        <span className="block truncate text-sm">
          <span className="font-medium">{author}:</span> {messageExcerpt(latest)}
        </span>
      </span>
    </button>
  );
}

function ThreadParticipants({ replies }: { replies: readonly ChannelConversationMessage[] }) {
  const { agent } = useChannelPane();
  const participants = threadParticipants(replies);

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {participants.slice(0, VISIBLE_PARTICIPANTS).map((sender) =>
        sender.type === "agent" ? (
          <AgentAvatar
            key={sender.agentId}
            agent={agent(sender.agentId)}
            className="size-4.5 rounded-sm"
          />
        ) : (
          <span
            key="user"
            aria-hidden
            className="inline-flex size-4.5 items-center justify-center rounded-sm bg-primary text-primary-foreground"
          >
            <UserRound className="size-3" />
          </span>
        ),
      )}
      {participants.length > VISIBLE_PARTICIPANTS && (
        <span className="pl-0.5 text-2xs text-muted-foreground tabular-nums">
          +{participants.length - VISIBLE_PARTICIPANTS}
        </span>
      )}
    </span>
  );
}

function replyCount(count: number): string {
  return count === 1 ? "1 reply" : `${count} replies`;
}

/** One line of a message's text, or what it shared when it has none. */
function messageExcerpt({ content, attachments }: ChannelConversationMessage): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (text) return text;
  return attachments?.length ? "Shared an attachment" : "";
}
