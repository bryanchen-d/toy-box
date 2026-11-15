// Observers of finished executions. A stream reports each execution that ends on its own or with an
// error; an aborted or deleted one reports nothing, because whoever stopped it wanted no result.

import type { SessionCompletion } from "@sessions/model";
import { sharedSet } from "@/shared/server/processState";

export type SessionCompletionListener = (sessionId: string, completion: SessionCompletion) => void;

const listeners = sharedSet<SessionCompletionListener>("session-completion-listeners");

export function subscribeSessionCompletions(listener: SessionCompletionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishSessionCompletion(sessionId: string, completion: SessionCompletion): void {
  for (const listener of listeners) {
    try {
      listener(sessionId, completion);
    } catch (error) {
      console.error(`A completion observer failed for session ${sessionId}:`, error);
    }
  }
}
