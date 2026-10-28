import type { Message, SessionEvent, SessionState } from "./index";
import { applySessionEvent, createInitialSessionState } from "./reducer";
import { computeSessionDiffs, type SessionDiffs } from "./editDiffs";

export const SESSION_PAGE_SIZE = 50;

/** Browser read projection, not a replacement for canonical execution state. */
export type SessionView = SessionState & {
  messageOffset: number;
  messageCount: number;
  hiddenMessageIndices: number[];
  editDiffs: SessionDiffs;
  lastVoiceMessage?: string;
};

export type SessionOutputs = Pick<
  SessionView,
  "editDiffs" | "lastVoiceMessage" | "lastSeenEventId"
>;

export type SessionHistoryPage = Pick<SessionState, "messages" | "lastSeenEventId"> & {
  messageOffset: number;
  messageCount: number;
};

function isHiddenMessage(message: Message): boolean {
  return (
    message.role === "assistant" && !message.content && !message.error && !message.toolCalls?.length
  );
}

export function projectSessionHistory(state: SessionState, start: number): SessionHistoryPage {
  const messageOffset = Math.min(start, state.messages.length);
  return {
    messages: state.messages.slice(messageOffset, messageOffset + SESSION_PAGE_SIZE),
    messageOffset,
    messageCount: state.messages.length,
    lastSeenEventId: state.lastSeenEventId,
  };
}

export function projectSessionOutputs(
  state: SessionState,
  cwd?: string,
  editDiffs = computeSessionDiffs(state.messages, cwd),
): SessionOutputs {
  let lastVoiceMessage: string | undefined;
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message.role !== "system" && message.content.trim()) {
      lastVoiceMessage = message.content.trim().slice(0, 1000);
      break;
    }
  }
  return { editDiffs, lastVoiceMessage, lastSeenEventId: state.lastSeenEventId };
}

export function projectSessionView(
  state: SessionState,
  cwd?: string,
  editDiffs = computeSessionDiffs(state.messages, cwd),
): SessionView {
  return {
    ...state,
    ...projectSessionHistory(state, Math.max(0, state.messages.length - SESSION_PAGE_SIZE)),
    ...projectSessionOutputs(state, cwd, editDiffs),
    hiddenMessageIndices: state.messages.flatMap((message, index) =>
      isHiddenMessage(message) ? [index] : [],
    ),
  };
}

export function createInitialSessionView(initial: Partial<SessionState> = {}): SessionView {
  return projectSessionView(createInitialSessionState(initial));
}

/** Reduce only the recent window with the one canonical reducer, then bound its retention. */
export function applySessionViewEvent(view: SessionView, event: SessionEvent): SessionView {
  const next = applySessionEvent(view, event);
  const messageCount = view.messageOffset + next.messages.length;
  const messages = next.messages.slice(-SESSION_PAGE_SIZE);
  return {
    ...view,
    ...next,
    messages,
    messageOffset: messageCount - messages.length,
    messageCount,
    hiddenMessageIndices: [
      ...view.hiddenMessageIndices.filter((index) => index < view.messageOffset),
      ...next.messages.flatMap((message, index) =>
        isHiddenMessage(message) ? [view.messageOffset + index] : [],
      ),
    ],
  };
}

/** Only these events can mutate already-reduced older rows. */
export function changesSessionHistory(event: SessionEvent): boolean {
  return (
    "toolCallId" in event ||
    ("parentToolCallId" in event && !!event.parentToolCallId) ||
    event.type === "end"
  );
}

export function applySessionHistoryEvent(
  page: SessionHistoryPage,
  event: SessionEvent,
): SessionHistoryPage {
  if (!changesSessionHistory(event)) return page;
  const state = createInitialSessionState(page);
  const next = applySessionEvent(
    state,
    event.type === "end" ? { ...event, reason: "idle" } : event,
  );
  // Root tool starts append only to the actual tail, never to an older page.
  if (event.type === "tool_start" && !event.parentToolCallId) return page;
  return { ...page, messages: next.messages, lastSeenEventId: next.lastSeenEventId };
}

export function sessionHistoryStarts(
  start: number,
  end: number,
  recentOffset: number,
  hiddenMessageIndices: readonly number[],
): number[] {
  const starts = new Set<number>();
  const hidden = new Set(hiddenMessageIndices);
  for (let index = start; index <= end && index < recentOffset; index++) {
    if (!hidden.has(index)) starts.add(Math.floor(index / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE);
  }
  return [...starts];
}

export function getSessionViewMessage(
  view: SessionView,
  pages: readonly SessionHistoryPage[],
  index: number,
): Message | undefined {
  if (index >= view.messageOffset) return view.messages[index - view.messageOffset];
  const page = pages.find(
    (page) => index >= page.messageOffset && index < page.messageOffset + page.messages.length,
  );
  return page?.messages[index - page.messageOffset];
}
