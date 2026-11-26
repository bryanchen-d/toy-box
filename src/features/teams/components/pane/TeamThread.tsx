import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useMutation } from "@tanstack/react-query";
import { MessageSquareReply } from "lucide-react";
import {
  teamTaskById,
  teamTaskByThread,
  type TeamState,
  type PostTeamMessageInput,
} from "@teams/model";
import { findTeamTaskMessage } from "@teams/server/functions";
import { TranscriptSkeleton } from "@/shared/messages/TranscriptSkeleton";
import { Button } from "@/shared/ui/button";
import { PaneMessage } from "@/shared/ui/pane-message";
import { ScrollableFade } from "@/shared/ui/scrollable-fade";
import { TeamComposer, type TeamComposerHandle } from "./TeamComposer";
import { TeamPaneProvider, useTeamPane } from "./TeamPaneContext";
import { TeamMessageSearch } from "./TeamMessageSearch";
import { TeamPanelHeader } from "./TeamPanelHeader";
import { TaskCard } from "./TaskCard";
import type { TeamMessageMatch } from "@teams/model/search";
import { isTeamTaskWorkingNow } from "@teams/model/presence";
import { TranscriptRowContent } from "./transcript/TeamTranscript";
import { threadRows } from "./transcript/transcriptRows";

// Within this distance of the end, new replies keep the thread scrolled to them.
const FOLLOW_THRESHOLD_PX = 80;

/**
 * One thread beside the transcript, or in its place in a narrow pane: its top-level message, every
 * reply, and a composer that replies in it. A task's view is its thread under its record; a task
 * without a thread yet shows an empty history, and the first reply starts it. It opens on the
 * pending question it holds, otherwise on its latest reply, and follows new replies while the
 * reader is at the end.
 */
export function TeamThread({
  teamId,
  sequence,
  taskId,
  selectedSequence,
  isVisible,
  state,
  composerRef,
  onLoadThrough,
  onReply,
  onClose,
}: {
  teamId: string;
  /** The thread's top-level message, for a thread opened as one. */
  sequence?: number;
  /** The task whose view this is, which follows the task as its thread starts. */
  taskId?: string;
  selectedSequence?: number;
  isVisible: boolean;
  state: TeamState;
  composerRef: RefObject<TeamComposerHandle | null>;
  /** Loads older history through the thread's top-level message. */
  onLoadThrough: (sequence: number) => Promise<void>;
  onReply: (
    message: Pick<PostTeamMessageInput, "content" | "attachments" | "threadSequence" | "taskId">,
  ) => Promise<unknown>;
  onClose: () => void;
}) {
  const pane = useTeamPane();
  const { lead, members, coordinators } = pane;
  const paneRef = useRef<HTMLElement>(null);
  const [searchSelection, setSearchSelection] = useState<TeamMessageMatch | null>(null);
  const targetSequence = searchSelection?.sequence ?? selectedSequence;
  const targetLoaded = state.messages.some(({ sequence }) => sequence === targetSequence);
  const scrollRef = useRef<HTMLElement>(null);
  const followsEndRef = useRef(true);
  const landedRef = useRef(false);
  // A task's thread is its view: the task's record heads its history.
  const task =
    taskId === undefined
      ? sequence === undefined
        ? undefined
        : teamTaskByThread(state.tasks, sequence)
      : teamTaskById(state.tasks, taskId);
  const threadSequence = sequence ?? task?.threadSequence;
  const rows =
    threadSequence === undefined
      ? []
      : threadRows(state.messages, threadSequence, {
          lead,
          members,
          coordinators,
          tasks: state.tasks,
          pendingRequests: state.team.pendingRequests,
        });
  const replyCount = state.messages.filter(
    (message) => threadSequence !== undefined && message.threadSequence === threadSequence,
  ).length;
  // Loaded history always reaches the newest message, so it holds the thread once it reaches here.
  const isLoaded =
    threadSequence === undefined || (state.messages[0]?.sequence ?? 1) <= threadSequence;
  // A task without a thread yet may still be cited by earlier messages.
  const mention = useMutation({
    mutationFn: (id: string) => findTeamTaskMessage({ data: { teamId, taskId: id } }),
    onSuccess: (location) => {
      if (location) pane.openMessage(location);
    },
  });

  useEffect(() => {
    if (!isLoaded && threadSequence !== undefined) void onLoadThrough(threadSequence);
  }, [isLoaded, onLoadThrough, threadSequence]);

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
        aria-label={task ? `Task ${task.id}` : "Thread"}
        className="flex h-full min-h-0 min-w-0 flex-col bg-panel outline-none"
      >
        <TeamPanelHeader
          icon={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-m-2 text-muted-foreground"
              aria-label={task ? "Close task" : "Close thread"}
              title={task ? "Close task" : "Close thread"}
              onClick={onClose}
            >
              <MessageSquareReply aria-hidden />
            </Button>
          }
          title={task ? `${task.id} · ${task.title}` : "Thread"}
        />
        {threadSequence !== undefined && (
          <TeamMessageSearch
            teamId={teamId}
            threadSequence={threadSequence}
            isVisible={isVisible}
            hotkeyTarget={paneRef}
            onSelect={setSearchSelection}
          />
        )}
        <div className="min-h-0 flex-1">
          {!isLoaded ? (
            <TranscriptSkeleton />
          ) : rows.length === 0 && !task ? (
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
                {task && (
                  <div className="rounded-lg border bg-background p-3">
                    <TaskCard
                      task={task}
                      owners={pane.agents}
                      artifacts={state.artifacts}
                      workingNow={isTeamTaskWorkingNow(task, pane.presence)}
                    />
                  </div>
                )}
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
                {task && threadSequence === undefined && (
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <p>No replies yet. A reply here starts this task's thread.</p>
                    {mention.data === null ? (
                      <p role="status">No message mentions {task.id} yet.</p>
                    ) : (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        disabled={mention.isPending}
                        onClick={() => mention.mutate(task.id)}
                      >
                        Show the latest message that mentions {task.id}
                      </Button>
                    )}
                    {mention.error && (
                      <p role="alert" className="text-destructive">
                        Unable to find a message about {task.id}: {mention.error.message}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </ScrollableFade>
          )}
        </div>
        <div className="shrink-0 border-t bg-background px-4 pt-4 md:pb-4">
          <TeamComposer
            teamId={teamId}
            threadSequence={threadSequence}
            task={task}
            state={state}
            handleRef={composerRef}
            onSubmit={(message) => {
              followsEndRef.current = true;
              return onReply(
                threadSequence === undefined
                  ? { ...message, taskId: task!.id }
                  : { ...message, threadSequence },
              );
            }}
          />
        </div>
      </section>
    </TeamPaneProvider>
  );
}
