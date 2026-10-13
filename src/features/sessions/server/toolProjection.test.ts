import { expect, test } from "bun:test";
import { resolveToolCallPolicy } from "./toolProjection";
import { createInitialSessionState, applySessionEvent } from "../model/reducer";
import type { SessionEvent } from "../model";

function project(name: string, result: unknown, success = true): SessionEvent[] {
  const policy = resolveToolCallPolicy(name, {}, { sessionId: "owner" });
  if (policy?.kind !== "translated") throw new Error("Expected a translated tool result.");
  return policy.projectOnComplete?.({ success, result: JSON.stringify(result) }) ?? [];
}

test("screen and URL publication reduce through one durable session preview contract", () => {
  const screen = project("set_session_preview", {
    preview: { kind: "screen", screenId: "window:1:2:3" },
  });
  const first = screen.reduce(applySessionEvent, createInitialSessionState());
  expect(first.preview).toEqual({ kind: "screen", screenId: "window:1:2:3" });
  const web = project("set_session_preview", {
    preview: { kind: "url", url: "http://localhost:4200" },
  });
  const changed = web.reduce(applySessionEvent, first);
  expect(changed.preview).toEqual({ kind: "url", url: "http://localhost:4200" });
  expect(first.preview).toEqual({ kind: "screen", screenId: "window:1:2:3" });
  expect(
    project("set_session_preview", { preview: null }).reduce(applySessionEvent, changed).preview,
  ).toBeUndefined();
  expect([...screen, ...web].reduce(applySessionEvent, createInitialSessionState())).toEqual(
    changed,
  );
});

test("failed or malformed tools never publish a runnable preview", () => {
  expect(
    project("set_session_preview", { preview: { kind: "screen", screenId: "x" } }, false),
  ).toEqual([]);
  expect(project("set_session_preview", { preview: { kind: "screen", screenId: "" } })).toEqual([]);
  expect(
    project("set_session_preview", { preview: { kind: "url", url: "javascript:alert(1)" } }),
  ).toEqual([]);
  expect(project("set_session_preview", { unrelated: true })).toEqual([]);
});
