import { describe, expect, test } from "bun:test";
import { ActionType, chatReducer, type ChatState } from "@microsoft/agent-host-protocol";
import type { SessionEvent } from "@sessions/model";
import { applySessionEvent, createInitialSessionState } from "@sessions/model/reducer";
import { encodeSystemMessage } from "@sessions/model/systemMessages";
import {
  createChatProjector,
  projectTurns,
  SYSTEM_MESSAGE_META,
  toolArguments,
  type NativeChat,
} from "./projector";

const turnId = "turn-1";
const user = { kind: "user" };

/** A remote autopilot turn: a reply, a shell call, a push Agent Teams refused, and the answer. */
const turnActions = [
  {
    type: ActionType.ChatTurnStarted,
    turnId,
    startedAt: "2026-11-16T10:00:00.000Z",
    message: {
      text: "<agent_teams_instructions>Report to your owner.</agent_teams_instructions>\n\nCount the files.",
      origin: user,
    },
  },
  {
    type: ActionType.ChatResponsePart,
    turnId,
    part: { kind: "markdown", id: "m1", content: "Let me " },
  },
  { type: ActionType.ChatDelta, turnId, partId: "m1", content: "check." },
  {
    type: ActionType.ChatToolCallStart,
    turnId,
    toolCallId: "c1",
    toolName: "powershell",
    displayName: "Run",
  },
  {
    type: ActionType.ChatToolCallReady,
    turnId,
    toolCallId: "c1",
    invocationMessage: "Run ls",
    toolInput: '{"command":"ls"}',
    confirmed: "not-needed",
  },
  {
    type: ActionType.ChatToolCallComplete,
    turnId,
    toolCallId: "c1",
    result: {
      success: true,
      pastTenseMessage: "Ran ls",
      content: [
        {
          type: "terminal",
          resource: "t://1",
          title: "ls",
          result: { exitCode: 0, preview: "a.txt" },
        },
      ],
    },
  },
  {
    type: ActionType.ChatToolCallStart,
    turnId,
    toolCallId: "c2",
    toolName: "powershell",
    displayName: "Run",
  },
  {
    type: ActionType.ChatToolCallReady,
    turnId,
    toolCallId: "c2",
    invocationMessage: "Push",
    toolInput: '{"command":"git push"}',
  },
  {
    type: ActionType.ChatToolCallConfirmed,
    turnId,
    toolCallId: "c2",
    approved: false,
    reason: "denied",
    reasonMessage: "Security held this push.",
  },
  {
    type: ActionType.ChatToolCallComplete,
    turnId,
    toolCallId: "c2",
    result: { success: false, pastTenseMessage: "The user rejected this tool call." },
  },
  {
    type: ActionType.ChatResponsePart,
    turnId,
    part: { kind: "markdown", id: "m2", content: "One file." },
  },
  { type: ActionType.ChatTurnComplete, turnId, duration: 1000 },
];

function emptyChat(): ChatState {
  return {
    resource: "ahp-chat:/chat",
    title: "",
    status: 0,
    modifiedAt: "2026-11-16T10:00:00.000Z",
    turns: [],
  } as unknown as ChatState;
}

function playLive(actions: readonly object[]) {
  const { project } = createChatProjector();
  let chat = emptyChat();
  const events: SessionEvent[] = [];
  for (const action of actions) {
    chat = chatReducer(chat, action as never);
    events.push(...project(action, chat as unknown as NativeChat));
  }
  return { chat, events };
}

const transcript = (events: SessionEvent[]) =>
  events.reduce(applySessionEvent, createInitialSessionState()).messages;

describe("agent host projection", () => {
  test("a remote turn watched live and reopened from history builds the same transcript", () => {
    const { chat, events } = playLive(turnActions);
    const live = transcript(events);

    expect(live).toEqual(transcript(projectTurns(chat.turns as never)));
    expect(live[0]).toMatchObject({ role: "user", content: "Count the files.", clientId: turnId });
    const [reply, answer] = live.slice(1);
    expect(reply).toMatchObject({
      role: "assistant",
      content: "Let me check.",
      toolCalls: [
        {
          id: "c1",
          name: "powershell",
          arguments: { command: "ls" },
          result: { success: true, content: "a.txt" },
        },
        {
          id: "c2",
          arguments: { command: "git push" },
          result: { success: false, content: "Security held this push." },
        },
      ],
    });
    expect(answer).toMatchObject({ role: "assistant", content: "One file." });
    expect(events.at(-1)).toEqual({ type: "end", reason: "idle" });
  });

  test("a system message Agent Teams sent reads as that system message", () => {
    const content = { type: "sub_session_wake", reason: "CI on PR 42" } as const;
    const started = {
      type: ActionType.ChatTurnStarted,
      turnId,
      startedAt: "2026-11-16T10:00:00.000Z",
      message: {
        text: "The wake you scheduled is due.",
        origin: user,
        _meta: { [SYSTEM_MESSAGE_META]: encodeSystemMessage(content) },
      },
    };
    const { chat, events } = playLive([started]);

    expect(events[0]).toEqual({ type: "system_message", content, clientId: turnId });
    expect(chat.activeTurn).toBeDefined();
  });

  test("a failed turn ends with its error", () => {
    const { events } = playLive([
      turnActions[0]!,
      {
        type: ActionType.ChatError,
        turnId,
        duration: 10,
        part: { kind: "error", error: { errorType: "rate_limited", message: "Rate limited." } },
      },
    ]);

    expect(events.at(-1)).toEqual({ type: "end", reason: "error", error: "Rate limited." });
  });

  test("tool input that isn't a JSON object stays whole", () => {
    expect(toolArguments('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
    expect(toolArguments("*** Begin Patch")).toEqual({ input: "*** Begin Patch" });
    expect(toolArguments('["a"]')).toEqual({ input: '["a"]' });
    expect(toolArguments(undefined)).toEqual({});
  });

  test("a turn the host restarts from its steering message carries on as one turn", () => {
    const steering = { text: "Stop and summarize.", origin: user };
    const { events } = playLive([
      turnActions[0]!,
      {
        type: ActionType.ChatPendingMessageSet,
        kind: "steering",
        id: "steer-1",
        message: steering,
      },
      { type: ActionType.ChatTurnComplete, turnId, duration: 10 },
      {
        type: ActionType.ChatTurnStarted,
        turnId: "turn-2",
        startedAt: "2026-11-16T10:00:05.000Z",
        message: steering,
        queuedMessageId: "steer-1",
      },
      {
        type: ActionType.ChatResponsePart,
        turnId: "turn-2",
        part: { kind: "markdown", id: "m3", content: "Summary." },
      },
      { type: ActionType.ChatTurnComplete, turnId: "turn-2", duration: 10 },
    ]);

    expect(events.filter(({ type }) => type === "end")).toEqual([{ type: "end", reason: "idle" }]);
    expect(events).toContainEqual({
      type: "user_message",
      content: "Stop and summarize.",
      clientId: "steer-1",
    });
  });

  test("a tool's completion, echoed and then reported again by the host, ends it once", () => {
    const { events } = playLive([...turnActions.slice(0, 6), turnActions[5]!]);

    expect(events.filter(({ type }) => type === "tool_end")).toHaveLength(1);
  });
});
