// Process-local workspace state for session lifecycle.

import {
  reduceWorkspaceSessionState,
  type WorkspaceSessionEvent,
  type WorkspaceSessionState,
} from "@workspace/model/state/reducer";
import { sharedMap } from "@/shared/server/processState";

const sessionStates = sharedMap<WorkspaceSessionState>("workspace-session-states");

export function getSessionStates(): Record<string, WorkspaceSessionState> {
  return Object.fromEntries(sessionStates);
}

export function getSessionState(sessionId: string): WorkspaceSessionState | undefined {
  return sessionStates.get(sessionId);
}

export function applySessionState(event: WorkspaceSessionEvent): boolean {
  const current = getSessionState(event.sessionId);
  const next = reduceWorkspaceSessionState(current, event);
  if (next === current) return false;

  if (next) sessionStates.set(event.sessionId, next);
  else sessionStates.delete(event.sessionId);
  return true;
}

export function deleteSessionState(sessionId: string): boolean {
  return sessionStates.delete(sessionId);
}
