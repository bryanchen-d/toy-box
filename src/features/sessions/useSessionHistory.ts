import { useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { SessionEvent } from "./model";
import {
  applySessionHistoryEvent,
  changesSessionHistory,
  getSessionViewMessage,
  sessionHistoryStarts,
  type SessionHistoryPage,
  type SessionView,
} from "./model/view";
import { sessionQueries } from "./queries";
import { querySessionHistory } from "./server/functions";
import { sessionFetch } from "./observeSession";

type HistoryRevision = {
  version: number;
  eventId?: number;
  /** null fences global changes (end) or an overflowing pending-read change set. */
  changedToolCallIds?: Set<string | null>;
};

export async function readCurrentHistoryPage(
  read: () => Promise<SessionHistoryPage>,
  revision: () => HistoryRevision,
  signal: AbortSignal,
): Promise<SessionHistoryPage> {
  for (;;) {
    signal.throwIfAborted();
    revision().changedToolCallIds?.clear();
    const before = revision().version;
    const page = await read();
    signal.throwIfAborted();
    const current = revision();
    if (
      before === current.version ||
      (page.lastSeenEventId !== undefined &&
        current.eventId !== undefined &&
        page.lastSeenEventId >= current.eventId) ||
      (current.changedToolCallIds &&
        !current.changedToolCallIds.has(null) &&
        !page.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.toolCalls?.some((tool) => current.changedToolCallIds?.has(tool.id)),
        ))
    ) {
      return page;
    }
  }
}

/** The virtual viewport owns older page subscriptions. Inactive pages are not retained. */
export function useSessionHistory(sessionId: string, view: SessionView, enabled: boolean) {
  const client = useQueryClient();
  const [range, setRange] = useState({ start: 0, end: -1 });
  const revision = useRef<HistoryRevision>({ version: 0 });
  const pendingChanges = useRef(new Set<Set<string | null>>());
  const starts = enabled
    ? sessionHistoryStarts(range.start, range.end, view.messageOffset, view.hiddenMessageIndices)
    : [];
  const results = useQueries({
    queries: starts.map((start) => ({
      ...sessionQueries.history(sessionId, start),
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        const changes = new Set<string | null>();
        pendingChanges.current.add(changes);
        return readCurrentHistoryPage(
          () =>
            querySessionHistory({
              data: { sessionId, start },
              signal,
              fetch: sessionFetch,
            }),
          () => ({ ...revision.current, changedToolCallIds: changes }),
          signal,
        ).finally(() => pendingChanges.current.delete(changes));
      },
    })),
  });
  const pages = results.flatMap((result) => (result.data ? [result.data] : []));
  const getMessage = (index: number) => getSessionViewMessage(view, pages, index);
  const onRangeChange = (start: number, end: number) => {
    setRange((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end },
    );
  };

  function apply(event: SessionEvent) {
    if (!changesSessionHistory(event)) return;
    revision.current = { version: revision.current.version + 1, eventId: event.eventId };
    const toolCallId =
      ("parentToolCallId" in event && event.parentToolCallId) ||
      ("toolCallId" in event ? event.toolCallId : null);
    for (const changes of pendingChanges.current) {
      if (changes.has(null)) continue;
      if (changes.size >= 1500) {
        changes.clear();
        changes.add(null);
      } else changes.add(toolCallId);
    }
    client.setQueriesData<SessionHistoryPage>(
      { queryKey: sessionQueries.historyKey(sessionId) },
      (page) => (page ? applySessionHistoryEvent(page, event) : page),
    );
  }

  function refresh() {
    revision.current = { version: revision.current.version + 1, eventId: undefined };
    // Reset cancels in-flight reads and discards old row values before fetching
    // only the currently subscribed ranges.
    void client
      .resetQueries({ queryKey: sessionQueries.historyKey(sessionId) })
      .catch((error: unknown) => console.error("Session history refresh failed:", error));
  }

  return {
    getMessage,
    hiddenMessageIndices: view.hiddenMessageIndices,
    onRangeChange,
    apply,
    refresh,
    error: results.find((result) => result.error)?.error,
  };
}
