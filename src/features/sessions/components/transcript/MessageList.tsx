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

export function SessionMessageList({
  messages,
  isStreaming,
  isWaiting,
  status,
  reasoningContent,
  scrollToBottomRef,
}: {
  messages: SessionTranscriptMessage[];
  isStreaming: boolean;
  isWaiting: boolean;
  status: SessionStatus;
  reasoningContent: string;
  scrollToBottomRef: MutableRefObject<(() => void) | null>;
}) {
  if (messages.length === 0) return <TranscriptPlaceholder />;

  return (
    <VirtualizedMessageList
      messages={messages}
      isStreaming={isStreaming}
      isWaiting={isWaiting}
      status={status}
      reasoningContent={reasoningContent}
      scrollToBottomRef={scrollToBottomRef}
    />
  );
}

function VirtualizedMessageList({
  messages,
  isStreaming,
  isWaiting,
  status,
  reasoningContent,
  scrollToBottomRef,
}: {
  messages: SessionTranscriptMessage[];
  isStreaming: boolean;
  isWaiting: boolean;
  status: SessionStatus;
  reasoningContent: string;
  scrollToBottomRef: MutableRefObject<(() => void) | null>;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const rows = useMemo(() => createTranscriptRows(messages), [messages]);
  // TanStack caches measurements and append anchors by this callback's identity.
  const getItemKey = useCallback((index: number) => rows[index].key, [rows]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 112,
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
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const message = row.message;
            const content = message && (
              <Message
                message={message}
                isStreaming={isStreaming}
                isBusy={isStreaming && status !== "background"}
                isLast={row.messageIndex === messages.length - 1}
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
