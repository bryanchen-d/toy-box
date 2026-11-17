import { describe, expect, mock, test } from "bun:test";
import { ActionType, chatReducer, type ChatState } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { z } from "zod";
import type { SessionEvent } from "@sessions/model";
import { defineTool } from "@sessions/server/tools/definition";
import { SessionConnectionUnavailableError, type SessionToolGuard } from "../provider";
import { connectRemoteSession, type AgentHost } from "./connection";
import { INSTRUCTIONS_START } from "./projector";

const CHAT = "ahp-chat:/chat-1";
const CLIENT_ID = "agent-teams-client";

/**
 * An agent host that keeps the chat's state and echoes each action to the clients subscribed to
 * it, and a node whose connection to it can drop, reconnect, or be given up on.
 */
function fakeNode() {
  let chat = { turns: [] } as unknown as ChatState;
  const dispatched: Record<string, any>[] = [];
  const feeds = new Set<{ push: (event: unknown) => void; end: () => void }>();
  const apply = (action: object) => {
    chat = chatReducer(chat, action as never, () => {});
    for (const feed of feeds) feed.push({ type: "action", params: { action } });
  };

  function connectClient() {
    let feed: { push: (event: unknown) => void; end: () => void } | undefined;
    let open = true;
    const client = {
      request: async () => ({ snapshot: { state: { defaultChat: CHAT } } }),
      subscribe: async () => {
        const queue: unknown[] = [];
        let wake = () => {};
        let ended = false;
        feed = {
          push: (event) => {
            queue.push(event);
            wake();
          },
          end: () => {
            ended = true;
            wake();
          },
        };
        feeds.add(feed);
        async function* events() {
          for (;;) {
            while (queue.length) yield queue.shift();
            if (ended) return;
            await new Promise<void>((resolve) => (wake = resolve));
          }
        }
        return { result: { snapshot: { state: structuredClone(chat) } }, subscription: events() };
      },
      dispatch: (channel: string, action: Record<string, any>) => {
        if (!open) throw new Error("The client is closed.");
        dispatched.push(action);
        if (channel === CHAT) apply(action);
      },
      unsubscribe: async () => {},
    };
    return {
      client: client as unknown as AhpClient,
      close() {
        open = false;
        if (feed) {
          feeds.delete(feed);
          feed.end();
        }
      },
    };
  }

  let current: ReturnType<typeof connectClient> | undefined = connectClient();
  let reconnected = Promise.withResolvers<AhpClient | undefined>();
  const host: AgentHost = {
    node: { name: "brchen-db3", scratchFolder: "C:/scratch" },
    get client() {
      return current?.client;
    },
    clientId: CLIENT_ID,
    agents: [],
    whenConnected: () => (current ? Promise.resolve(current.client) : reconnected.promise),
    onConnected: () => () => {},
  };
  return {
    host,
    apply,
    dispatched: (type: ActionType) => dispatched.filter((action) => action.type === type),
    drop() {
      current?.close();
      current = undefined;
      reconnected = Promise.withResolvers();
    },
    reconnect() {
      current = connectClient();
      reconnected.resolve(current.client);
    },
    giveUp() {
      reconnected.resolve(undefined);
    },
  };
}

const recordValue = defineTool("record_value", {
  description: "Records a value.",
  parameters: z.object({ value: z.string() }),
  handler: ({ value }) => `Recorded ${value}.`,
});

async function connect(
  guard: Partial<SessionToolGuard> = {},
  tools: Parameters<typeof connectRemoteSession>[0]["configuration"]["tools"] = [recordValue],
) {
  const node = fakeNode();
  const review = mock(guard.review ?? (async () => ({ allowed: true as const })));
  const screen = mock(guard.screen ?? (async (_action, result) => result));
  const connection = await connectRemoteSession({
    providerId: "node:brchen-db3",
    host: node.host,
    sessionId: "session-1",
    models: [],
    configuration: {
      directory: "",
      allowUserQuestions: false,
      tools,
      instructions: "Work carefully.",
      skillDirectories: [],
      toolGuard: { review, screen },
    },
  });
  const events: SessionEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return { node, connection, review, events };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(1);
  expect(condition()).toBe(true);
}

const message = (clientId: string, content: string) =>
  ({ role: "user", clientId, content }) as const;
const ours = { kind: "client", clientId: CLIENT_ID };

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

const reply = (id: string, content: string) => ({
  type: ActionType.ChatResponsePart,
  turnId: "m1",
  part: { kind: "markdown", id, content },
});

describe("remote session connection", () => {
  test("a new session's first message carries Agent Teams' instructions; later ones don't", async () => {
    const { node, connection, events } = await connect();

    await connection.send(message("m1", "Check the build."));
    await until(() => events.some(({ type }) => type === "user_message"));
    node.apply({ type: ActionType.ChatTurnComplete, turnId: "m1", duration: 1 });
    await until(() => events.some(({ type }) => type === "end"));
    await connection.send(message("m2", "Now the tests."));

    const [first, second] = node.dispatched(ActionType.ChatTurnStarted);
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
    const { node, connection, review } = await connect({
      screen: async (_action, result) => `${result} (screened)`,
    });
    await connection.send(message("m1", "Record x."));

    for (const action of heldCall("call-1", "record_value", { value: "x" }, ours)) {
      node.apply(action);
    }

    await until(() => node.dispatched(ActionType.ChatToolCallComplete).length === 1);
    expect(node.dispatched(ActionType.ChatToolCallConfirmed)).toEqual([
      expect.objectContaining({ approved: true, selectedOptionId: "approve-once" }),
    ]);
    expect(node.dispatched(ActionType.ChatToolCallComplete)[0]).toMatchObject({
      toolCallId: "call-1",
      result: { success: true, content: [{ type: "text", text: "Recorded x. (screened)" }] },
    });
    expect(review).toHaveBeenCalledWith({ type: "tool", name: "record_value" });
  });

  test("the guard decides each held native call, choosing the host's matching option", async () => {
    const { node, connection } = await connect({
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
      node.apply(action);
    }

    await until(() => node.dispatched(ActionType.ChatToolCallConfirmed).length === 2);
    expect(node.dispatched(ActionType.ChatToolCallConfirmed)).toEqual([
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
    const { node, connection, events } = await connect();
    await connection.send(message("m1", "Start."));
    await until(() => events.some(({ type }) => type === "user_message"));

    await connection.send({ ...message("m2", "Also check Linux."), immediate: true });

    expect(node.dispatched(ActionType.ChatPendingMessageSet)).toEqual([
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
});

describe("a dropped node", () => {
  test("the run is followed again once the node reconnects, from where it got to", async () => {
    const { node, connection, events } = await connect();
    await connection.send(message("m1", "Count the files."));
    node.apply(reply("r1", "Count"));
    await until(() => events.some(({ type }) => type === "delta"));

    node.drop();
    await expect(connection.send(message("m2", "Hurry."))).rejects.toBeInstanceOf(
      SessionConnectionUnavailableError,
    );
    // The run goes on at the node while Agent Teams is away.
    node.apply({ type: ActionType.ChatDelta, turnId: "m1", partId: "r1", content: "ing." });
    for (const action of heldCall("call-1", "powershell", { command: "ls" })) node.apply(action);
    node.apply({
      type: ActionType.ChatToolCallConfirmed,
      turnId: "m1",
      toolCallId: "call-1",
      approved: true,
      confirmed: "user-action",
    });
    node.apply({
      type: ActionType.ChatToolCallComplete,
      turnId: "m1",
      toolCallId: "call-1",
      result: {
        success: true,
        pastTenseMessage: "Ran ls",
        content: [{ type: "text", text: "a.txt" }],
      },
    });
    node.apply(reply("r2", "One file."));
    node.apply({ type: ActionType.ChatTurnComplete, turnId: "m1", duration: 1 });
    node.reconnect();

    await until(() => events.some(({ type }) => type === "end"));
    expect(events.slice(events.findIndex(({ type }) => type === "delta") + 1)).toEqual([
      { type: "assistant_message", messageId: "r1", content: "Counting." },
      {
        type: "tool_start",
        toolName: "powershell",
        toolCallId: "call-1",
        arguments: { command: "ls" },
      },
      { type: "tool_end", toolCallId: "call-1", success: true, result: "a.txt" },
      { type: "assistant_message", messageId: "r2", content: "One file." },
      { type: "end", reason: "idle" },
    ]);
    expect(node.dispatched(ActionType.SessionActiveClientSet)).toHaveLength(2);
  });

  test("an answer the drop lost is sent again once the node reconnects", async () => {
    const released = Promise.withResolvers<void>();
    const slow = defineTool("record_value", {
      description: "Records a value.",
      parameters: z.object({ value: z.string() }),
      handler: async ({ value }) => {
        await released.promise;
        return `Recorded ${value}.`;
      },
    });
    const { node, connection } = await connect({}, [slow]);
    await connection.send(message("m1", "Record x."));
    for (const action of heldCall("call-1", "record_value", { value: "x" }, ours)) {
      node.apply(action);
    }
    await until(() => node.dispatched(ActionType.ChatToolCallConfirmed).length === 1);

    node.drop();
    released.resolve();
    await Bun.sleep(5);
    expect(node.dispatched(ActionType.ChatToolCallComplete)).toEqual([]);
    node.reconnect();

    await until(() => node.dispatched(ActionType.ChatToolCallComplete).length === 1);
    expect(node.dispatched(ActionType.ChatToolCallComplete)[0]).toMatchObject({
      toolCallId: "call-1",
      result: { success: true },
    });
  });

  test("a node that stays out of reach ends the run, and the connection must be reacquired", async () => {
    const { node, connection, events } = await connect();
    await connection.send(message("m1", "Start."));

    node.drop();
    node.giveUp();

    await until(() => events.some(({ type }) => type === "end"));
    expect(events.at(-1)).toMatchObject({
      type: "end",
      reason: "error",
      error: expect.stringContaining("brchen-db3 is out of reach"),
    });
    await expect(connection.send(message("m2", "Again."))).rejects.toBeInstanceOf(
      SessionConnectionUnavailableError,
    );
  });
});
