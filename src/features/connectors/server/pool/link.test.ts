import { describe, expect, onTestFinished, test } from "bun:test";
import { InMemoryTransport, type AhpTransport } from "@microsoft/agent-host-protocol/client";
import type { PoolNode } from "../../model";
import type { AgentPoolConnectorRecord } from "../database";
import { PoolLink, poolStatus, type PoolLinkDependencies } from "./link";

describe("pool link", () => {
  test("connects each node and signs its host in with the owner's GitHub token", async () => {
    const host = fakeHost();
    const link = startPool([node("brchen-db3")], { openTransport: host.open });

    await until(() => link.status.state === "connected");
    expect(host.requests.map(({ method }) => method)).toEqual(["initialize", "authenticate"]);
    expect(host.requests[0]!.params).toMatchObject({
      clientId: "client-1",
      initialSubscriptions: ["ahp-root://"],
    });
    expect(host.requests[1]!.params).toEqual({
      channel: "ahp-root://",
      resource: "https://api.github.com",
      token: "gh-token",
    });
  });

  test("a dropped node reconnects under the same client ID", async () => {
    const host = fakeHost();
    const link = startPool([node("brchen-db3")], { openTransport: host.open });
    await until(() => link.status.state === "connected");

    host.drop();
    await until(() => host.opened === 2 && link.status.state === "connected");
    const handshakes = host.requests.filter(({ method }) => method === "initialize");
    expect(handshakes.map(({ params }) => params.clientId)).toEqual(["client-1", "client-1"]);
  });

  test("a node it can't reach leaves the others connected", async () => {
    const host = fakeHost();
    const link = startPool([node("brchen-db3"), node("brchen-db4")], {
      openTransport: async (target) => {
        if (target.name === "brchen-db4") throw new Error("tunnel not hosted");
        return host.open();
      },
    });

    await until(() => link.status.state === "connected");
    expect(host.opened).toBe(1);
  });
});

describe("pool status", () => {
  const connected = (since: string) => ({ state: "connected" as const, since });

  test("is connected since the earliest connected node", () => {
    expect(
      poolStatus([
        { name: "a", status: connected("2026-11-14T02:00:00Z") },
        { name: "b", status: { state: "connecting", since: "2026-11-14T00:00:00Z", error: "x" } },
        { name: "c", status: connected("2026-11-14T01:00:00Z") },
      ]),
    ).toEqual(connected("2026-11-14T01:00:00Z"));
  });

  test("without a connected node, names each node it can't reach since the last was lost", () => {
    expect(
      poolStatus([
        { name: "a", status: { state: "unreachable", since: "2026-11-14T00:00:00Z", error: "x" } },
        { name: "b", status: { state: "connecting", since: "2026-11-14T03:00:00Z", error: "y" } },
      ]),
    ).toEqual({ state: "connecting", since: "2026-11-14T03:00:00Z", error: "a: x; b: y" });
  });

  test("is unreachable only once every node is", () => {
    expect(
      poolStatus([
        { name: "a", status: { state: "unreachable", since: "2026-11-14T00:00:00Z" } },
        { name: "b", status: { state: "unreachable", since: "2026-11-14T01:00:00Z" } },
      ]),
    ).toEqual({ state: "unreachable", since: "2026-11-14T01:00:00Z" });
  });
});

function node(name: string): PoolNode {
  return {
    name,
    transport: { type: "http", url: "http://127.0.0.1:31790" },
    tokenFile: "unused",
    workspaces: [],
    scratchFolder: "C:/scratch",
    computeSlots: 9_999,
    draining: false,
  };
}

function startPool(nodes: PoolNode[], overrides: Partial<PoolLinkDependencies>) {
  const record: AgentPoolConnectorRecord = {
    id: "pool-1",
    name: "Pool",
    kind: "agentPool",
    nodes,
    clientId: "client-1",
    receivedThrough: 0,
    createdAt: "2026-11-14T00:00:00Z",
    updatedAt: "2026-11-14T00:00:00Z",
  };
  const link = new PoolLink(record, {
    openTransport: async () => {
      throw new Error("no host");
    },
    githubToken: async () => "gh-token",
    onChange: () => {},
    timing: {
      pingIntervalMs: 10,
      requestTimeoutMs: 1_000,
      reconnectBackoff: { min: 5, max: 20 },
    },
    ...overrides,
  });
  link.start();
  onTestFinished(() => link.stop());
  return link;
}

/** An agent host that answers the handshake, sign-in, and pings, and can drop its connections. */
function fakeHost() {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const connections: AhpTransport[] = [];
  return {
    requests,
    get opened() {
      return connections.length;
    },
    open: async (): Promise<AhpTransport> => {
      const [client, server] = InMemoryTransport.pair();
      connections.push(server);
      void serve(server, requests);
      return client;
    },
    drop() {
      for (const connection of connections) void connection.close();
    },
  };
}

async function serve(
  server: AhpTransport,
  requests: { method: string; params: Record<string, unknown> }[],
): Promise<void> {
  for (;;) {
    const frame = await server.recv();
    if (!frame) return;
    if (frame.kind !== "text") continue;
    const message = JSON.parse(frame.text);
    if (message.id === undefined || !message.method) continue;
    if (message.method !== "ping")
      requests.push({ method: message.method, params: message.params });
    await server.send({
      jsonrpc: "2.0",
      id: message.id,
      result:
        message.method === "initialize"
          ? {
              protocolVersion: "1.0.0",
              serverSeq: 0,
              snapshots: [
                {
                  resource: "ahp-root://",
                  fromSeq: 0,
                  state: {
                    agents: [
                      {
                        provider: "copilotcli",
                        displayName: "Copilot",
                        description: "",
                        models: [],
                        protectedResources: [{ resource: "https://api.github.com" }],
                      },
                    ],
                  },
                },
              ],
            }
          : {},
    });
  }
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the pool.");
    await Bun.sleep(5);
  }
}
