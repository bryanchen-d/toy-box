// Live executions waiting on a provider that went silent. A healthy model step answers within a
// minute or two, so a session silent for 15 minutes while no tool, question, or background work is
// pending will not end on its own, and messages sent to it never reach it.

import type { AssistantMessage, SessionState } from "@sessions/model";
import { sharedSet } from "@/shared/server/processState";
import { SessionStream } from "./sessionStream";

const STALL_AFTER_MS = 15 * 60_000;

export type SessionStall = {
  sessionId: string;
  /** When its provider last said anything, or when the session began waiting on a silent one. */
  since: string;
  /** Messages sent to the session that haven't reached it. */
  queuedMessages: number;
};

const listeners = sharedSet<(stall: SessionStall) => void>("session-stall-listeners");

export function subscribeSessionStalls(listener: (stall: SessionStall) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// When each live session began waiting on its provider, the provider event it had last heard,
// and whether that silence was reported.
const watches = new Map<string, { since: number; heard?: number; reported: boolean }>();

/**
 * Report each live session that has waited 15 minutes on a silent provider, once per silence.
 * The clock starts at the later of the provider's last event and when the session began waiting,
 * so time spent running a tool, answering a question, or in background work never counts.
 */
export function reportStalledSessions(now = Date.now()): void {
  const live = new Set(SessionStream.getSessionIds());
  for (const sessionId of watches.keys()) if (!live.has(sessionId)) watches.delete(sessionId);
  for (const sessionId of live) {
    const stream = SessionStream.get(sessionId)!;
    const state = stream.getSessionState();
    if (!awaitsProvider(state)) {
      watches.delete(sessionId);
      continue;
    }
    const heard = stream.lastProviderEventAt;
    let watch = watches.get(sessionId);
    if (!watch) watches.set(sessionId, (watch = { since: now, heard, reported: false }));
    else if (watch.heard !== heard) Object.assign(watch, { heard, reported: false });
    if (watch.reported || now - Math.max(watch.since, heard ?? 0) < STALL_AFTER_MS) continue;
    watch.reported = true;

    const stall: SessionStall = {
      sessionId,
      since: new Date(heard ?? watch.since).toISOString(),
      queuedMessages: state.queuedMessages.length,
    };
    console.warn(
      `Session ${sessionId} has heard nothing from its provider since ${stall.since} while ${state.status}, with no tool, question, or background work pending. Queued messages: ${stall.queuedMessages}.`,
    );
    for (const listener of listeners) {
      try {
        listener(stall);
      } catch (error) {
        console.error(`A stall observer failed for session ${sessionId}:`, error);
      }
    }
  }
}

/** Mid-turn with only the provider left to act; a pending question is a tool call without a result. */
function awaitsProvider(state: SessionState): boolean {
  if (state.status === "idle" || state.status === "background") return false;
  const lastAssistant = [...state.messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant");
  return !lastAssistant?.toolCalls?.some((tool) => !tool.result);
}
