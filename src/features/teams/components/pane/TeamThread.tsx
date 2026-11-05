import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { MessageSquareReply } from "lucide-react";
import type { TeamState, PostTeamMessageInput } from "@teams/model";
import { TranscriptSkeleton } from "@/shared/messages/TranscriptSkeleton";
import { PaneMessage } from "@/shared/ui/pane-message";
import { ScrollableFade } from "@/shared/ui/scrollable-fade";
import { TeamComposer, type TeamComposerHandle } from "./TeamComposer";
import { TeamPaneProvider, useTeamPane } from "./TeamPaneContext";
import { TeamMessageSearch } from "./TeamMessageSearch";
import { TeamPanelHeader } from "./TeamPanelHeader";
import type { TeamMessageMatch } from "@teams/model/search";
import { TranscriptRowContent } from "./transcript/TeamTranscript";
import { threadRows } from "./transcript/transcriptRows";

// Within this distance of the end, new replies keep the thread scrolled to them.
const FOLLOW_THRESHOLD_PX = 80;

/**
 * One thread beside the transcript, or in its place in a narrow pane: its top-level message, every
 * reply, and a composer that replies in it. It opens on the pending question it holds, otherwise on
 * its latest reply, and follows new replies while the reader is at the end.
 */
export function TeamThread({
  teamId,
  sequence,
  selectedSequence,
  isVisible,
  state,
  composerRef,
  onLoadThrough,
  onReply,
}: {
  teamId: string;
  /** The thread's top-level message. */
  sequence: number;
  selectedSequence?: number;
  isVisible: boolean;
  state: TeamState;
  composerRef: RefObject<TeamComposerHandle | null>;
  /** Loads older history through the thread's top-level message. */
  onLoadThrough: (sequence: number) => Promise<void>;
  onReply: (message: Pick<PostTeamMessageInput, "content" | "attachments">) => Promise<unknown>;
}) {
  const pane = useTeamPane();
  const { lead, members } = pane;
  const paneRef = useRef<HTMLElement>(null);
  const [searchSelection, setSearchSelection] = useState<TeamMessageMatch | null>(null);
  const targetSequence = searchSelection?.sequence ?? selectedSequence;
  const targetLoaded = state.messages.some(({ sequence }) => sequence === targetSequence);
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
    if (!isLoaded || !targetLoaded || !scrollRef.current) return;
    const target = scrollRef.current.querySelector(`[data-message-sequence="${targetSequence}"]`);
    if (!target) return;
    landedRef.current = true;
    followsEndRef.current = false;
    target.scrollIntoView({ block: "center" });
  }, [isLoaded, targetLoaded, targetSequence, searchSelection]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !isLoaded) return;
    if (!landedRef.current) {
      landedRef.current = true;
      const question = scrollElement.querySelector("[data-request-sequence]");
      if (question) {
        followsEndRef.current = false;
        question.scrollIntoView({ block: "center" });
        return;
      }
    }
    if (followsEndRef.current) scrollElement.scrollTop = scrollElement.scrollHeight;
  }, [isLoaded, replyCount]);

  return (
    <TeamPaneProvider value={{ ...pane, selectedMessageSequence: targetSequence }}>
      <section
        ref={paneRef}
        tabIndex={-1}
        aria-label="Thread"
        className="flex h-full min-h-0 min-w-0 flex-col bg-panel outline-none"
      >
        <TeamPanelHeader icon={MessageSquareReply} title="Thread" />
        <TeamMessageSearch
          teamId={teamId}
          threadSequence={sequence}
          isVisible={isVisible}
          hotkeyTarget={paneRef}
          onSelect={setSearchSelection}
        />
        <div className="min-h-0 flex-1">
          {!isLoaded ? (
            <TranscriptSkeleton />
          ) : rows.length === 0 ? (
            <PaneMessage
              title="Thread unavailable"
              detail="Its message is no longer in this team."
            />
          ) : (
            <ScrollableFade
              ref={scrollRef}
              axis="vertical"
              rootClassName="size-full"
              onScroll={({ currentTarget }) => {
                followsEndRef.current =
                  currentTarget.scrollHeight -
                    currentTarget.scrollTop -
                    currentTarget.clientHeight <
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
          <TeamComposer
            teamId={teamId}
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
    </TeamPaneProvider>
  );
}
