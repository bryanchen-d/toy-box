import { useRef } from "react";
import { MessageSquareReply } from "lucide-react";
import { AgentAvatar } from "@teams/components/agents/AgentAvatar";
import { AgentMentionMarkdown } from "@teams/components/agents/AgentMentionMarkdown";
import { connectorOriginLabel, type TeamAgentIdentity } from "@teams/model";
import type { ConnectorOrigin } from "@connectors/model";
import { CopyControl } from "@/shared/messages/CopyControl";
import { AttachmentGallery } from "@/shared/attachments/AttachmentGallery";
import { Button } from "@/shared/ui/button";
import { ClockTime } from "@/shared/ui/clock-time";
import { ShowMore, useShowMore } from "@/shared/ui/show-more";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { waitingOutlineClassName } from "@/shared/ui/running-indicator";
import { cn } from "@/shared/utils";
import { useTeamPane } from "../TeamPaneContext";
import { TeamReactions } from "./TeamReactions";
import { RequestTag } from "./RequestTag";
import { ThreadSummary } from "./ThreadReplies";
import type { AgentRunEntry } from "./transcriptRows";
import { CopyTeamUri } from "@teams/components/CopyTeamUri";

/** One agent's consecutive messages under a single avatar. */
export function AgentRun({
  agentId,
  entries,
}: {
  agentId: string;
  entries: readonly AgentRunEntry[];
}) {
  const agent = useTeamPane().agent(agentId);

  return (
    <article className="flex gap-3">
      <AgentAvatar agent={agent} />
      <div className="min-w-0 max-w-full space-y-2 @md:max-w-[80%]">
        {entries.map((entry) => (
          <AgentMessage key={entry.message.id} entry={entry} agent={agent} />
        ))}
      </div>
    </article>
  );
}

function AgentMessage({
  entry: { message, body, startsRun, addressee, request, showHeader, collapsible, thread },
  agent,
}: {
  entry: AgentRunEntry;
  agent: TeamAgentIdentity;
}) {
  const { teamId, selectedMessageSequence, replyInThread } = useTeamPane();
  const textRef = useRef<HTMLDivElement>(null);
  const { collapsed, clamped, toggle } = useShowMore(textRef, message.content, collapsible);
  const attachments = message.attachments ?? [];

  return (
    <div
      className={cn(
        "group/entry",
        selectedMessageSequence === message.sequence && "rounded-lg ring-2 ring-primary/40",
      )}
      data-message-sequence={message.sequence}
      data-request-sequence={request === "pending" ? message.sequence : undefined}
    >
      {showHeader && (
        <div className="mb-1 flex h-4.5 min-w-0 items-center gap-2 text-xs">
          {startsRun && (
            <span className={cn("shrink-0 font-semibold", agent.deleted && "italic")}>
              {agent.name}
            </span>
          )}
          {addressee && (
            <span className="min-w-0 truncate text-muted-foreground">→ {addressee}</span>
          )}
          <ClockTime className="shrink-0 text-2xs text-muted-foreground" date={message.timestamp} />
          {message.origin && <MessageOrigin origin={message.origin} />}
          {request && <RequestTag state={request} />}
        </div>
      )}
      {message.content && (
        <div className="relative">
          <div
            className={cn(
              "relative rounded-xl border bg-secondary-background px-3.5 py-2.5 text-left text-sm",
              request === "pending" && waitingOutlineClassName,
            )}
          >
            <div
              ref={textRef}
              className={cn(
                collapsed && "max-h-40 overflow-hidden",
                clamped &&
                  "[mask-image:linear-gradient(to_bottom,black_40%,transparent_calc(100%_-_1.5rem))]",
              )}
            >
              <AgentMentionMarkdown content={body} />
            </div>
            {/* Collapsed, the toggle floats over the faded end; expanded, it closes the text. */}
            {toggle && (
              <ShowMore {...toggle} className={cn(clamped && "absolute bottom-2 left-3.5 mt-0")} />
            )}
          </div>
          <div className="pointer-events-none absolute -top-3 right-2 flex items-center gap-0.5 rounded-md border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within/entry:pointer-events-auto group-focus-within/entry:opacity-100 group-hover/entry:pointer-events-auto group-hover/entry:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Reply to ${agent.name} in thread`}
                    onClick={() => replyInThread(message)}
                  >
                    <MessageSquareReply aria-hidden />
                  </Button>
                }
              />
              <TooltipContent sideOffset={4}>Reply in thread</TooltipContent>
            </Tooltip>
            <CopyControl content={message.content} />
            <CopyTeamUri
              variant="button"
              target={{ type: "message", teamId, sequence: message.sequence }}
              label="Copy message URI"
            />
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <AttachmentGallery attachments={attachments} variant="filmstrip" />
          {!message.content && (
            <CopyTeamUri
              variant="button"
              target={{ type: "message", teamId, sequence: message.sequence }}
              label="Copy message URI"
            />
          )}
        </div>
      )}
      <TeamReactions message={message} className="mt-2" />
      {thread && <ThreadSummary thread={thread} className="mt-1 -ml-1.5" />}
    </div>
  );
}

/** Where a connector's message came from, linking to the original when the connector shared it. */
function MessageOrigin({ origin }: { origin: ConnectorOrigin }) {
  const label = `via ${connectorOriginLabel(origin)}`;
  return origin.permalink ? (
    <a
      href={origin.permalink}
      target="_blank"
      rel="noreferrer"
      className="min-w-0 truncate text-muted-foreground underline decoration-current/40 underline-offset-2 hover:decoration-current"
    >
      {label}
    </a>
  ) : (
    <span className="min-w-0 truncate text-muted-foreground">{label}</span>
  );
}
