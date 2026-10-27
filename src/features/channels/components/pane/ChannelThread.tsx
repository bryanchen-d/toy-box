import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { MessageSquareReply, X } from "lucide-react";
import type { ChannelState, PostChannelMessageInput } from "@channels/model";
import { TranscriptSkeleton } from "@/shared/messages/TranscriptSkeleton";
import { Button } from "@/shared/ui/button";
import { PaneMessage } from "@/shared/ui/pane-message";
import { ScrollableFade } from "@/shared/ui/scrollable-fade";
import { ChannelComposer, type ChannelComposerHandle } from "./ChannelComposer";
import { useChannelPane } from "./ChannelPaneContext";
import { TranscriptRowContent } from "./transcript/ChannelTranscript";
import { threadRows } from "./transcript/transcriptRows";

// Within this distance of the end, new replies keep the thread scrolled to them.
const FOLLOW_THRESHOLD_PX = 80;

/**
 * One thread beside the transcript, or in its place in a narrow pane: its top-level message, every
 * reply, and a composer that replies in it. It opens on the pending question it holds, otherwise on
 * its latest reply, and follows new replies while the reader is at the end.
 */
export function ChannelThread({
  channelId,
  sequence,
  state,
  composerRef,
  onLoadThrough,
  onReply,
  onClose,
}: {
  channelId: string;
  /** The thread's top-level message. */
  sequence: number;
  state: ChannelState;
  composerRef: RefObject<ChannelComposerHandle | null>;
  /** Loads older history through the thread's top-level message. */
  onLoadThrough: (sequence: number) => Promise<void>;
  onReply: (message: Pick<PostChannelMessageInput, "content" | "attachments">) => Promise<unknown>;
  onClose: () => void;
}) {
  const { lead, members } = useChannelPane();
  const scrollRef = useRef<HTMLElement>(null);
  const followsEndRef = useRef(true);
  const landedRef = useRef(false);
  const rows = threadRows(state.messages, sequence, { lead, members });
  const replyCount = state.messages.filter(
    ({ threadSequence }) => threadSequence === sequence,
  ).length;
  // Loaded history always reaches the newest message, so it holds the thread once it reaches here.
  const isLoaded = (state.messages[0]?.sequence ?? 1) <= sequence;

  useEffect(() => {
    if (!isLoaded) void onLoadThrough(sequence);
  }, [isLoaded, onLoadThrough, sequence]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !isLoaded) return;
    if (!landedRef.current) {
      landedRef.current = true;
      const question = scrollElement.querySelector("[data-request-sequence]");
      if (question) {
        question.scrollIntoView({ block: "center" });
        return;
      }
    }
    if (followsEndRef.current) scrollElement.scrollTop = scrollElement.scrollHeight;
  }, [isLoaded, replyCount]);

  return (
    <section aria-label="Thread" className="flex h-full min-h-0 min-w-0 flex-col bg-panel">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-background px-3 pr-24">
        <MessageSquareReply className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 truncate text-sm font-medium">Thread</h2>
        {/* Beside the title, clear of the pane's own actions in the top-right corner. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close thread"
          title="Close thread"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {!isLoaded ? (
          <TranscriptSkeleton />
        ) : rows.length === 0 ? (
          <PaneMessage
            title="Thread unavailable"
            detail="Its message is no longer in this channel."
          />
        ) : (
          <ScrollableFade
            ref={scrollRef}
            axis="vertical"
            rootClassName="size-full"
            onScroll={({ currentTarget }) => {
              followsEndRef.current =
                currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight <
                FOLLOW_THRESHOLD_PX;
            }}
          >
            <div className="@container space-y-5 px-4 py-5">
              {rows.map((row, index) => (
                <div key={row.key}>
                  <TranscriptRowContent row={row} />
                  {index === 0 && (
                    <div className="mt-5 flex items-center gap-2">
                      <span className="section-heading">
                        {replyCount === 1 ? "1 reply" : `${replyCount} replies`}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollableFade>
        )}
      </div>
      <div className="shrink-0 border-t bg-background px-4 pt-4 md:pb-4">
        <ChannelComposer
          channelId={channelId}
          threadSequence={sequence}
          state={state}
          handleRef={composerRef}
          onSubmit={(message) => {
            followsEndRef.current = true;
            return onReply(message);
          }}
        />
      </div>
    </section>
  );
}
