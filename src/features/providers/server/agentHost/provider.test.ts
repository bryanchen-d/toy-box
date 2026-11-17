import { expect, test } from "bun:test";
import { ActionType } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { createNodeProvider } from "./provider";
import type { AgentHost } from "./connection";

test("closing a session while its node is away stops and archives it there once the node is back", async () => {
  const dispatched: { channel: string; action: Record<string, unknown> }[] = [];
  const client = {
    request: async (_method: string, { channel }: { channel: string }) => ({
      snapshot: {
        state: channel.startsWith("ahp-session:")
          ? { defaultChat: "ahp-chat:/chat-1" }
          : { turns: [], activeTurn: { id: "turn-1", responseParts: [] } },
      },
    }),
    dispatch: (channel: string, action: Record<string, unknown>) =>
      void dispatched.push({ channel, action }),
    unsubscribe: async () => {},
  } as unknown as AhpClient;
  const listeners: ((client: AhpClient) => void)[] = [];
  const host: AgentHost = {
    node: { name: "brchen-db3", scratchFolder: "C:/scratch" },
    client: undefined,
    clientId: "client-1",
    agents: [],
    whenConnected: async () => undefined,
    onConnected: (listener) => {
      listeners.push(listener);
      return () => {};
    },
  };
  const provider = createNodeProvider(host);

  await provider.delete("session-1");
  expect(dispatched).toEqual([]);
  for (const listener of listeners) listener(client);

  await Bun.sleep(5);
  expect(dispatched).toEqual([
    {
      channel: "ahp-chat:/chat-1",
      action: { type: ActionType.ChatTurnCancelled, turnId: "turn-1", duration: 0 },
    },
    {
      channel: "ahp-session:/session-1",
      action: { type: ActionType.SessionIsArchivedChanged, isArchived: true },
    },
  ]);
});
