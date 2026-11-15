import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ToolInvocation } from "@github/copilot-sdk";
import type { SubSessionRequest } from "../model/subSessions";
import * as subSessionsModule from "./subSessions";

const realSubSessionsModule = { ...subSessionsModule };
const createMock = mock(async (_owner: string, _request: SubSessionRequest) => ({
  sessionId: "sub-1",
}));
const closeMock = mock(async (_owner: string, _sessionId: string) => ({ closed: true as const }));

mock.module("@workers/server/subSessions", () => ({
  ...realSubSessionsModule,
  createSubSession: createMock,
  closeSubSession: closeMock,
}));

const { subSessionOwnerTools } = await import("./tools");

afterAll(() => {
  mock.module("@workers/server/subSessions", () => realSubSessionsModule);
});

beforeEach(() => {
  createMock.mockClear();
  closeMock.mockClear();
});

describe("sub session tools", () => {
  test("act for the invoking session, never an owner named in the arguments", async () => {
    const handler = (name: string) =>
      subSessionOwnerTools.find((candidate) => candidate.name === name)!.handler as (
        args: unknown,
        invocation: ToolInvocation,
      ) => Promise<unknown>;
    const request = {
      name: "Reconnect fix",
      brief: {
        goal: "Fix it.",
        context: "Flaky.",
        deliverable: "A PR.",
        acceptanceCriteria: ["Passes"],
      },
      parentSessionId: "someone-else",
    };

    const created = await handler("create_sub_session")(request, invocation());
    await handler("close_sub_session")({ sessionId: "sub-1" }, invocation());

    expect(JSON.parse(String(created))).toEqual({ sessionId: "sub-1" });
    expect(createMock.mock.calls[0]?.[0]).toBe("agent-teams-caller");
    expect(closeMock).toHaveBeenCalledWith("agent-teams-caller", "sub-1");
  });
});

function invocation(): ToolInvocation {
  return {
    sessionId: "agent-teams-caller",
    toolCallId: "tool-call",
    toolName: "create_sub_session",
    arguments: {},
  };
}
