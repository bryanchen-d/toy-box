import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
} from "react";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import * as m from "motion/react-m";
import type { Message as SessionTranscriptMessage, SessionStatus } from "../../model";
import { ScrollableFade } from "@/shared/ui/scrollable-fade";
import { ScrollToBottomButton } from "@/shared/ui/scroll-to-bottom-button";
import { TranscriptPlaceholder } from "./TranscriptPlaceholder";
import { Message } from "./messages/Message";
import { queuedMessageLayoutId } from "../composer/QueuedMessageList";
import { ReasoningDisplay, StatusIndicator } from "./SessionStatus";
import { createTranscriptRows } from "./rows";

type SessionMessageListProps = {
  messageCount: number;
  getMessage: (index: number) => SessionTranscriptMessage | undefined;
  hiddenMessageIndices: readonly number[];
  onRangeChange: (start: number, end: number) => void;
  historyError: Error | null | undefined;
  isStreaming: boolean;
  isWaiting: boolean;
  status: SessionStatus;
  reasoningContent: string;
  scrollToBottomRef: MutableRefObject<(() => void) | null>;
};

export function SessionMessageList(props: SessionMessageListProps) {
  if (props.messageCount === 0) return <TranscriptPlaceholder />;
  return <VirtualizedMessageList {...props} />;
}

function VirtualizedMessageList({
  messageCount,
  getMessage,
  hiddenMessageIndices,
  onRangeChange,
  historyError,
  isStreaming,
  isWaiting,
  status,
  reasoningContent,
  scrollToBottomRef,
}: SessionMessageListProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const rows = useMemo(
    () => createTranscriptRows(messageCount, getMessage, hiddenMessageIndices),
    [messageCount, getMessage, hiddenMessageIndices],
  );
  // TanStack caches measurements and append anchors by this callback's identity.
  const getItemKey = useCallback((index: number) => rows.at(index).key, [rows]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 112,
    initialOffset: () => rows.length * (112 + 12),
    overscan: 6,
    paddingStart: 16,
    paddingEnd: 16,
    gap: 12,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 40,
    observeElementRect: (instance, onChange) =>
      observeElementRect(instance, (rect) => {
        // The DOM already has the new viewport height; test the previous
        // virtual geometry before handing the resize to the scroll owner.
        const wasAtEnd =
          instance.scrollRect !== null &&
          instance.getTotalSize() - (instance.scrollOffset ?? 0) - instance.scrollRect.height <=
            instance.options.scrollEndThreshold;
        onChange(rect);
        if (wasAtEnd) instance.scrollToEnd();
      }),
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0] && rows.at(items[0].index).messageIndex;
  const last = items.at(-1);
  const end = last && (rows.at(last.index).messageIndex ?? messageCount - 1);
  useEffect(() => {
    if (first !== undefined && end !== undefined) onRangeChange(first, end);
  }, [first, end, onRangeChange]);

  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  useEffect(() => {
    const scrollToBottom = () => virtualizer.scrollToEnd();
    scrollToBottomRef.current = scrollToBottom;
    return () => {
      if (scrollToBottomRef.current === scrollToBottom) scrollToBottomRef.current = null;
    };
  }, [scrollToBottomRef, virtualizer]);

  return (
    <div className="h-full bg-panel relative">
      <ScrollableFade
        ref={scrollRef}
        axis="vertical"
        rootClassName="size-full"
        style={{ overflowAnchor: "none" }}
      >
        <div className="@container relative mx-4" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows.at(item.index);
            const message = row.message;
            const content = message && (
              <Message
                message={message}
                isStreaming={isStreaming}
                isBusy={isStreaming && status !== "background"}
                isLast={row.messageIndex === messageCount - 1}
              />
            );
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-message-index={row.messageIndex}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {message ? (
                  message.role === "user" && message.clientId ? (
                    <m.div
                      layoutId={queuedMessageLayoutId(message.clientId)}
                      layout="position"
                      layoutDependency={message.clientId}
                    >
                      {content}
                    </m.div>
                  ) : (
                    content
                  )
                ) : row.messageIndex !== undefined ? (
                  <div
                    className="min-h-24 py-4 text-sm text-muted-foreground"
                    role={historyError ? "alert" : undefined}
                  >
                    {historyError
                      ? `Unable to load history: ${historyError.message}`
                      : "Loading messages..."}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {isStreaming && reasoningContent && (
                      <ReasoningDisplay content={reasoningContent} />
                    )}
                    {isStreaming && !isWaiting && status !== "idle" && (
                      <StatusIndicator status={status} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollableFade>
      <ScrollToBottomButton
        isAtBottom={virtualizer.isAtEnd()}
        onScrollToBottom={() => virtualizer.scrollToEnd()}
      />
    </div>
  );
}
