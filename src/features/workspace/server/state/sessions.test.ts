import { describe, expect, onTestFinished, test } from "bun:test";
import {
  applySessionState,
  deleteSessionState,
  getSessionState,
  getSessionStates,
} from "./sessions";

describe("workspace session storage", () => {
  test("stores live and unread status, and forgets a session once it is idle", () => {
    const sessionId = `workspace-session-${crypto.randomUUID()}`;
    onTestFinished(() => deleteSessionState(sessionId));

    applySessionState({ type: "session.running", sessionId, at: 1 });
    expect(getSessionState(sessionId)).toEqual({ status: "running", since: 1 });
    applySessionState({ type: "session.unread", sessionId });
    expect(getSessionStates()[sessionId]).toEqual({ status: "unread" });
    applySessionState({ type: "session.read", sessionId });
    expect(getSessionState(sessionId)).toBeUndefined();
  });

  test("deletes a session's record", () => {
    const sessionId = `workspace-delete-${crypto.randomUUID()}`;
    onTestFinished(() => deleteSessionState(sessionId));

    applySessionState({ type: "session.unread", sessionId });
    expect(deleteSessionState(sessionId)).toBe(true);
    expect(getSessionState(sessionId)).toBeUndefined();
  });
});
