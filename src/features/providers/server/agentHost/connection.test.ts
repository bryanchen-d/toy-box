import { describe, expect, mock, test } from "bun:test";
import { ActionType } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { z } from "zod";
import type { SessionEvent } from "@sessions/model";
import { defineTool } from "@sessions/server/tools/definition";
import { SessionConnectionUnavailableError, type SessionToolGuard } from "../provider";
import { connectRemoteSession } from "./connection";
import { INSTRUCTIONS_START } from "./projector";

const CHAT = "ahp-chat:/chat-1";
const CLIENT_ID = "agent-teams-client";

/** A host that echoes each chat action it accepts to its subscribers, as the agent host does. */
function fakeHost() {
  const dispatched: Record<string, any>[] = [];
  const queue: unknown[] = [];
  let wake = () => {};
  let open = true;
  async function* actions() {
    for (;;) {
      while (queue.length) yield queue.shift();
      if (!open) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  const apply = (action: object) => {
    queue.push({ type: "action", params: { action } });
    wake();
  };
  const client = {
    request: async () => ({ snapshot: { state: { defaultChat: CHAT } } }),
    subscribe: async () => ({
      result: { snapshot: { state: { turns: [] } } },
      subscription: actions(),
    }),
    dispatch: (channel: string, action: Record<string, any>) => {
      dispatched.push(action);
      if (channel === CHAT) apply(action);
    },
    unsubscribe: async () => {},
  };
  return {
    client: client as unknown as AhpClient,
    dispatched: (type: ActionType) => dispatched.filter((action) => action.type === type),
    apply,
    drop() {
      open = false;
      wake();
    },
  };
}

const recordValue = defineTool("record_value", {
  description: "Records a value.",
  parameters: z.object({ value: z.string() }),
  handler: ({ value }) => `Recorded ${value}.`,
});

async function connect(guard: Partial<SessionToolGuard> = {}) {
  const host = fakeHost();
  const review = mock(guard.review ?? (async () => ({ allowed: true as const })));
  const screen = mock(guard.screen ?? (async (_action, result) => result));
  const toolGuard: SessionToolGuard = { review, screen };
  const connection = await connectRemoteSession({
    providerId: "node:brchen-db3",
    client: host.client,
    clientId: CLIENT_ID,
    sessionId: "session-1",
    models: [],
    configuration: {
      directory: "",
      allowUserQuestions: false,
      tools: [recordValue],
      instructions: "Work carefully.",
      skillDirectories: [],
      toolGuard,
    },
  });
  const events: SessionEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return { host, connection, review, events };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(1);
  expect(condition()).toBe(true);
}

const message = (clientId: string, content: string) =>
  ({ role: "user", clientId, content }) as const;

function heldCall(toolCallId: string, toolName: string, input: object, contributor?: object) {
  return [
    {
      type: ActionType.ChatToolCallStart,
      turnId: "m1",
      toolCallId,
      toolName,
      displayName: toolName,
      ...(contributor ? { contributor } : {}),
    },
    {
      type: ActionType.ChatToolCallReady,
      turnId: "m1",
      toolCallId,
      invocationMessage: toolName,
      toolInput: JSON.stringify(input),
      options: [
        { id: "approve-once", label: "Allow", kind: "approve" },
        { id: "deny-once", label: "Skip", kind: "deny" },
      ],
    },
  ];
}

describe("remote session connection", () => {
  test("a new session's first message carries Agent Teams' instructions; later ones don't", async () => {
    const { host, connection, events } = await connect();

    await connection.send(message("m1", "Check the build."));
    await until(() => events.some(({ type }) => type === "user_message"));
    host.apply({ type: ActionType.ChatTurnComplete, turnId: "m1", duration: 1 });
    await until(() => events.some(({ type }) => type === "end"));
    await connection.send(message("m2", "Now the tests."));

    const [first, second] = host.dispatched(ActionType.ChatTurnStarted);
    expect(first).toMatchObject({ turnId: "m1" });
    expect(first!.message.text).toStartWith(`${INSTRUCTIONS_START}\nWork carefully.\n`);
    expect(first!.message.text).toEndWith("Check the build.");
    expect(second!.message.text).toBe("Now the tests.");
    expect(events).toContainEqual({
      type: "user_message",
      content: "Check the build.",
      clientId: "m1",
    });
  });

  test("Agent Teams' own tool is approved, run, and completed with its screened result", async () => {
    const { host, connection, review } = await connect({
      screen: async (_action, result) => `${result} (screened)`,
    });
    await connection.send(message("m1", "Record x."));

    for (const action of heldCall(
      "call-1",
      "record_value",
      { value: "x" },
      {
        kind: "client",
        clientId: CLIENT_ID,
      },
    )) {
      host.apply(action);
    }

    await until(() => host.dispatched(ActionType.ChatToolCallComplete).length === 1);
    expect(host.dispatched(ActionType.ChatToolCallConfirmed)).toEqual([
      expect.objectContaining({ approved: true, selectedOptionId: "approve-once" }),
    ]);
    expect(host.dispatched(ActionType.ChatToolCallComplete)[0]).toMatchObject({
      toolCallId: "call-1",
      result: { success: true, content: [{ type: "text", text: "Recorded x. (screened)" }] },
    });
    expect(review).toHaveBeenCalledWith({ type: "tool", name: "record_value" });
  });

  test("the guard decides each held native call, choosing the host's matching option", async () => {
    const { host, connection } = await connect({
      review: async (action) =>
        action.type === "command"
          ? { allowed: false, reason: "Commands wait for the owner." }
          : { allowed: true },
    });
    await connection.send(message("m1", "Look around."));

    for (const action of [
      ...heldCall("call-1", "powershell", { command: "git push" }),
      ...heldCall("call-2", "web_fetch", { url: "https://example.com" }),
    ]) {
      host.apply(action);
    }

    await until(() => host.dispatched(ActionType.ChatToolCallConfirmed).length === 2);
    expect(host.dispatched(ActionType.ChatToolCallConfirmed)).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        approved: false,
        reasonMessage: "Commands wait for the owner.",
        selectedOptionId: "deny-once",
      }),
      expect.objectContaining({
        toolCallId: "call-2",
        approved: true,
        selectedOptionId: "approve-once",
      }),
    ]);
  });

  test("a message during a turn steers it", async () => {
    const { host, connection, events } = await connect();
    await connection.send(message("m1", "Start."));
    await until(() => events.some(({ type }) => type === "user_message"));

    await connection.send({ ...message("m2", "Also check Linux."), immediate: true });

    expect(host.dispatched(ActionType.ChatPendingMessageSet)).toEqual([
      expect.objectContaining({
        kind: "steering",
        id: "m2",
        message: expect.objectContaining({ text: "Also check Linux." }),
      }),
    ]);
    expect(events).toContainEqual({
      type: "user_message",
      content: "Also check Linux.",
      clientId: "m2",
    });
  });

  test("a lost node connection ends the turn, and the next send needs a new connection", async () => {
    const { host, connection, events } = await connect();
    await connection.send(message("m1", "Start."));

    host.drop();

    await until(() => events.some(({ type }) => type === "end"));
    expect(events.at(-1)).toMatchObject({ type: "end", reason: "error" });
    await expect(connection.send(message("m2", "Again."))).rejects.toBeInstanceOf(
      SessionConnectionUnavailableError,
    );
  });
});
