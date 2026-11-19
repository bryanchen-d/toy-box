import { afterAll, beforeEach, describe, expect, mock, onTestFinished, test } from "bun:test";
import type { SessionCompletion } from "@sessions/model";
import type { ConnectorEntry } from "@connectors/model";
import * as databaseModule from "@/server/database";
import * as sessionRuntimeModule from "@sessions/server/runtime";
import * as sessionRecordsModule from "@sessions/server/state/sessions";
import * as connectorsModule from "@connectors/server";
import * as admissionModule from "./admission";
import * as cleanupModule from "./cleanup";
import type { Worker } from "../model";

const realDatabaseModule = { ...databaseModule };
const realSessionRuntimeModule = { ...sessionRuntimeModule };
const realSessionRecordsModule = { ...sessionRecordsModule };
const realConnectorsModule = { ...connectorsModule };
const realAdmissionModule = { ...admissionModule };
const realCleanupModule = { ...cleanupModule };

let currentDb: Bun.SQL | undefined;
let nextSessionId = 0;
const running = new Set<string>();
const completions = new Map<string, SessionCompletion>();
/** The provider each session runs on, by session ID. */
const providers = new Map<string, string>();
let pools: ConnectorEntry[] = [];

type SpawnInput = Parameters<typeof admissionModule.spawnSessionWorker>[0];
const spawnMock = mock(async (input: SpawnInput) => {
  // Admission persists ownership before it returns its receipt.
  await Bun.sleep(5);
  const sessionId = `sub-${++nextSessionId}`;
  const worker = {
    type: "session" as const,
    sessionId,
    parentSessionId: input.parentSessionId,
    createdAt: new Date(nextSessionId * 1000).toISOString(),
    ephemeral: false,
    ...(input.name ? { name: input.name } : {}),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata as Worker["metadata"] }),
  };
  await (input.admit ? input.admit(worker) : registerWorkerSession(worker));
  if (input.message.model) providers.set(sessionId, input.message.model.provider);
  return { sessionId };
});
const deliverMock = mock(async (_sessionId: string, _message: unknown) => ({
  disposition: "started",
  waitForCompletion: async () => ({ status: "completed" as const }),
}));
const deleteWorkerMock = mock(async (sessionId: string, _type?: Worker["type"]) =>
  unregisterWorkerSession(sessionId),
);

mock.module("@/server/database", () => ({
  ...realDatabaseModule,
  getStateDatabase: async (options?: { createIfMissing?: boolean }) => {
    if (!currentDb && options?.createIfMissing === false) return null;
    if (!currentDb) throw new Error("Test database has not been opened.");
    return currentDb;
  },
}));
mock.module("@sessions/server/runtime", () => ({
  ...realSessionRuntimeModule,
  deliverSessionMessage: deliverMock,
  getSessionRuntimeStatus: (sessionId: string) => ({
    running: running.has(sessionId),
    queuedCount: running.has(sessionId) ? 1 : 0,
  }),
  waitForSessions: async (sessionIds: string[]) =>
    sessionIds.map((sessionId) => completions.get(sessionId) ?? { status: "completed" }),
}));
mock.module("@workers/server/admission", () => ({
  ...realAdmissionModule,
  spawnSessionWorker: spawnMock,
}));
mock.module("@workers/server/cleanup", () => ({
  ...realCleanupModule,
  deleteWorker: deleteWorkerMock,
}));
mock.module("@sessions/server/state/sessions", () => ({
  ...realSessionRecordsModule,
  readSession: async (id: string) =>
    providers.has(id) ? { id, provider: { id: providers.get(id) } } : undefined,
}));
mock.module("@connectors/server", () => ({
  ...realConnectorsModule,
  listConnectors: async () => pools,
}));

const {
  registerWorkerSession,
  unregisterWorkerSession,
  getPersistedWorker,
  readSubSessionHistory,
} = await import("./database");
const { createSessionGuard } = await import("@security/server/guard");
const {
  closeSubSession,
  createSubSession,
  listSubSessions,
  messageSubSession,
  noteWorking,
  remindOwnersOfIdleSubSessions,
  reportInterruptedSubSessions,
  reportToOwner,
  scheduleWake,
  wakeDueSubSessions,
} = await import("./subSessions");

afterAll(() => {
  mock.module("@/server/database", () => realDatabaseModule);
  mock.module("@sessions/server/runtime", () => realSessionRuntimeModule);
  mock.module("@sessions/server/state/sessions", () => realSessionRecordsModule);
  mock.module("@connectors/server", () => realConnectorsModule);
  mock.module("@workers/server/admission", () => realAdmissionModule);
  mock.module("@workers/server/cleanup", () => realCleanupModule);
});

beforeEach(async () => {
  currentDb = await databaseModule.createTestDatabase();
  onTestFinished(async () => {
    await currentDb?.close();
    currentDb = undefined;
  });
  nextSessionId = 0;
  running.clear();
  completions.clear();
  providers.clear();
  pools = [];
  spawnMock.mockClear();
  deliverMock.mockClear();
  deleteWorkerMock.mockClear();
});

const brief = {
  goal: "Fix the flaky reconnect test.",
  context: "It fails one run in ten.",
  deliverable: "A draft pull request link.",
  acceptanceCriteria: ["The test passes 50 runs in a row"],
};

describe("sub sessions", () => {
  test("start as retained Workers owned by the caller, with the brief as their first message", async () => {
    await registerWorkerSession({
      type: "team",
      sessionId: "agent-riley",
      teamId: "team-1",
      createdAt: new Date(0).toISOString(),
      ephemeral: false,
      name: "Riley",
    });
    const model = { provider: "copilot", name: "gpt-5.5" } as const;

    const result = await createSubSession("agent-riley", {
      name: "Reconnect fix",
      brief,
      model,
      directory: "C:/repos/toy-box",
      useWorktree: true,
    });

    expect(result).toEqual({ sessionId: "sub-1" });
    const [input] = spawnMock.mock.calls[0]!;
    expect(input).toMatchObject({
      parentSessionId: "agent-riley",
      name: "Reconnect fix",
      message: { model },
      location: { directory: "C:/repos/toy-box", useWorktree: true },
    });
    expect(input.ephemeral).toBeUndefined();
    expect(input.message.content).toStartWith("You are a sub session doing one task for Riley,");
    expect(input.message.content).toContain("## Goal\nFix the flaky reconnect test.");
  });

  test("refuse a sixth open sub session, even when requested all at once", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        createSubSession("owner", { name: `Task ${index + 1}`, brief }),
      ),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(5);
    const [refused] = results.filter((result) => result.status === "rejected");
    expect(String((refused as PromiseRejectedResult).reason)).toContain(
      "You already own 5 sub sessions (Task 1, Task 2, Task 3, Task 4, Task 5)",
    );

    await closeSubSession("owner", "sub-1");
    await expect(createSubSession("owner", { name: "Task 7", brief })).resolves.toEqual({
      sessionId: "sub-6",
    });
  });

  test("can't create sub sessions of their own", async () => {
    await registerWorkerSession({
      type: "session",
      sessionId: "sub-of-owner",
      parentSessionId: "owner",
      createdAt: new Date(0).toISOString(),
      ephemeral: false,
    });

    await expect(createSubSession("sub-of-owner", { name: "Nested", brief })).rejects.toThrow(
      "A sub session can't create sub sessions of its own",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("run on a node a pool lists, as that node's provider in a folder of its own", async () => {
    const { registerNodeProvider } = await import("@providers/server");
    onTestFinished(
      registerNodeProvider({
        node: { name: "brchen-db3", scratchFolder: "C:/scratch" },
        client: undefined,
        clientId: "client-1",
        agents: [],
        whenConnected: async () => undefined,
        onConnected: () => () => {},
      }),
    );
    const model = { provider: "copilot", name: "gpt-5.5" };

    await createSubSession("owner", { name: "UI check", brief, node: "brchen-db3", model });

    expect(spawnMock.mock.calls[0]![0].message.model).toEqual({
      provider: "node:brchen-db3",
      name: "gpt-5.5",
    });
    await expect(
      createSubSession("owner", { name: "Elsewhere", brief, node: "brchen-db9" }),
    ).rejects.toThrow("No agent pool lists the node brchen-db9.");
    await expect(
      createSubSession("owner", { name: "Here", brief, node: "brchen-db3", useWorktree: true }),
    ).rejects.toThrow("leave directory and useWorktree unset");
  });

  test("answer only to their owner", async () => {
    const { sessionId } = await createSubSession("owner", { name: "Reconnect fix", brief });

    await expect(messageSubSession("other-agent", sessionId, "Stop")).rejects.toThrow(
      "is not one of your sub sessions",
    );
    await expect(closeSubSession("other-agent", sessionId)).rejects.toThrow(
      "is not one of your sub sessions",
    );
    expect(await listSubSessions("other-agent")).toEqual({ subSessions: [] });
    expect(deliverMock).not.toHaveBeenCalled();
    expect(deleteWorkerMock).not.toHaveBeenCalled();

    expect(await messageSubSession("owner", sessionId, "Also check macOS", "call-1")).toEqual({
      disposition: "started",
    });
    expect(deliverMock).toHaveBeenCalledWith(sessionId, {
      content: "Also check macOS",
      clientId: "call-1",
    });
    expect(await closeSubSession("owner", sessionId)).toEqual({ closed: true });
    expect(deleteWorkerMock).toHaveBeenCalledWith(sessionId, "session");
    expect((await listSubSessions("owner")).subSessions).toEqual([]);
  });

  test("list each one's state, oldest first, with a preview of an idle one's last report", async () => {
    const first = await createSubSession("owner", { name: "Reconnect fix", brief });
    const second = await createSubSession("owner", { name: "Review threads", brief });
    const third = await createSubSession("owner", { name: "Lens check", brief });
    running.add(first.sessionId);
    completions.set(second.sessionId, { status: "completed", response: "x".repeat(1_200) });
    completions.set(third.sessionId, { status: "failed", error: "The node went away." });

    const { subSessions } = await listSubSessions("owner");

    expect(subSessions.map(({ name, state }) => [name, state])).toEqual([
      ["Reconnect fix", "working"],
      ["Review threads", "idle"],
      ["Lens check", "idle"],
    ]);
    expect(subSessions[0]).toMatchObject({ queuedMessages: 1 });
    expect(subSessions[0]).not.toHaveProperty("lastReport");
    expect(subSessions[1]!.lastReport).toBe(`${"x".repeat(1_000)}… (truncated)`);
    expect(subSessions[2]).toMatchObject({ lastError: "The node went away." });
  });

  test("wake their owner at once with each report, and only their owner", async () => {
    const { sessionId } = await createSubSession("owner", { name: "Reconnect fix", brief });
    await registerWorkerSession({
      type: "team",
      sessionId: "agent-riley",
      teamId: "team-1",
      createdAt: new Date(0).toISOString(),
      ephemeral: false,
    });

    await reportToOwner(sessionId, { status: "completed", response: "Opened PR 42." });
    await reportToOwner(sessionId, { status: "completed", response: "NO_UPDATE" });
    await reportToOwner("agent-riley", { status: "completed", response: "Not a sub session." });
    await reportToOwner("unknown-session", { status: "completed", response: "Gone." });

    expect(deliverMock.mock.calls).toEqual([
      [
        "owner",
        {
          systemMessage: {
            type: "sub_session_report",
            sessionId,
            name: "Reconnect fix",
            outcome: "completed",
            report: "Opened PR 42.",
          },
          immediate: true,
        },
      ],
    ]);
  });

  test("hand their owner the external writes they made, in a report or when closed", async () => {
    const { sessionId } = await createSubSession("owner", { name: "Reconnect fix", brief });
    const guard = createSessionGuard(sessionId);
    await guard.screen({ type: "command", command: "git push origin fix" }, "");
    await reportToOwner(sessionId, { status: "completed", response: "NO_UPDATE" });
    await guard.screen({ type: "command", command: "gh pr comment 42 --body Done" }, "");

    expect(deliverMock.mock.calls).toEqual([
      [
        "owner",
        {
          systemMessage: {
            type: "sub_session_report",
            sessionId,
            name: "Reconnect fix",
            outcome: "completed",
            report: "It had nothing else to report.",
            externalWrites: ["push commits to a remote: git push origin fix"],
          },
          immediate: true,
        },
      ],
    ]);
    expect(await closeSubSession("owner", sessionId)).toEqual({
      closed: true,
      unreportedExternalWrites: [
        "change GitHub issues or pull requests: gh pr comment 42 --body Done",
      ],
    });
  });

  test("wake once when their scheduled wake falls due, unless their owner wrote first", async () => {
    const waiting = await createSubSession("owner", { name: "Watch CI", brief });
    const redirected = await createSubSession("owner", { name: "Watch review", brief });
    const now = new Date("2026-11-14T10:00:00.000Z");
    await scheduleWake(waiting.sessionId, 20, "CI on PR 42", now);
    await scheduleWake(redirected.sessionId, 20, "a review", now);
    await expect(scheduleWake("owner", 20, "anything", now)).rejects.toThrow(
      "Only a sub session can schedule a wake.",
    );
    await messageSubSession("owner", redirected.sessionId, "Stop waiting; the review is in.");
    // The owner's message cancels the wake but keeps the brief.
    expect((await getPersistedWorker(redirected.sessionId))?.metadata).toEqual({ brief });
    deliverMock.mockClear();

    await wakeDueSubSessions(new Date("2026-11-14T10:19:00.000Z"));
    expect(deliverMock).not.toHaveBeenCalled();
    await wakeDueSubSessions(new Date("2026-11-14T10:20:00.000Z"));
    await wakeDueSubSessions(new Date("2026-11-14T10:21:00.000Z"));

    expect(deliverMock.mock.calls).toEqual([
      [waiting.sessionId, { systemMessage: { type: "sub_session_wake", reason: "CI on PR 42" } }],
    ]);
  });

  test("remind their owner once when left idle a day after reporting, unless it wrote since", async () => {
    const idle = await createSubSession("owner", { name: "Reconnect fix", brief });
    const busy = await createSubSession("owner", { name: "Lens check", brief });
    const answered = await createSubSession("owner", { name: "Review threads", brief });
    const reported = new Date("2026-11-14T10:00:00.000Z");
    for (const { sessionId } of [idle, busy, answered]) {
      await reportToOwner(sessionId, { status: "completed", response: "Done." }, reported);
    }
    await messageSubSession("owner", answered.sessionId, "Also update the docs.");
    running.add(busy.sessionId);
    deliverMock.mockClear();

    await remindOwnersOfIdleSubSessions(new Date("2026-11-15T09:59:00.000Z"));
    expect(deliverMock).not.toHaveBeenCalled();
    await remindOwnersOfIdleSubSessions(new Date("2026-11-15T10:00:00.000Z"));
    await remindOwnersOfIdleSubSessions(new Date("2026-11-16T10:00:00.000Z"));
    running.delete(busy.sessionId);
    await remindOwnersOfIdleSubSessions(new Date("2026-11-16T10:01:00.000Z"));

    expect(deliverMock.mock.calls).toEqual(
      [idle, busy].map(({ sessionId }, index) => [
        "owner",
        {
          systemMessage: {
            type: "sub_session_idle",
            sessionId,
            name: ["Reconnect fix", "Lens check"][index],
          },
        },
      ]),
    );
  });

  test("remind their owner only after the wake they scheduled has run", async () => {
    const waiting = await createSubSession("owner", { name: "Watch CI", brief });
    const turnEnd = new Date("2026-11-14T10:00:00.000Z");
    await scheduleWake(waiting.sessionId, 24 * 60, "CI on PR 42", turnEnd);
    await reportToOwner(waiting.sessionId, { status: "completed", response: "Pushed." }, turnEnd);
    deliverMock.mockClear();
    const dayLater = new Date("2026-11-15T10:00:00.000Z");

    await remindOwnersOfIdleSubSessions(dayLater);
    await wakeDueSubSessions(dayLater);
    running.add(waiting.sessionId);
    await remindOwnersOfIdleSubSessions(dayLater);
    running.delete(waiting.sessionId);
    await remindOwnersOfIdleSubSessions(dayLater);

    expect(deliverMock.mock.calls).toEqual([
      [waiting.sessionId, { systemMessage: { type: "sub_session_wake", reason: "CI on PR 42" } }],
      [
        "owner",
        {
          systemMessage: {
            type: "sub_session_idle",
            sessionId: waiting.sessionId,
            name: "Watch CI",
          },
        },
      ],
    ]);
  });
});

describe("sub sessions on nodes and cut-short runs", () => {
  const renderedBrief =
    "## Goal\nFix the flaky reconnect test.\n\n## Context\nIt fails one run in ten.\n\n## Deliverable\nA draft pull request link.\n\n## Acceptance criteria\n- The test passes 50 runs in a row";

  /** A pool listing brchen-db3 in the given state and brchen-db4 draining. */
  async function useNode(state: "connected" | "unreachable" = "connected") {
    const { registerNodeProvider } = await import("@providers/server");
    onTestFinished(
      registerNodeProvider({
        node: { name: "brchen-db3", scratchFolder: "C:/scratch" },
        client: undefined,
        clientId: "client-1",
        agents: [],
        whenConnected: async () => undefined,
        onConnected: () => () => {},
      }),
    );
    const node = (name: string, draining: boolean) => ({
      name,
      workspaces: [],
      scratchFolder: "C:/scratch",
      computeSlots: 9_999,
      draining,
    });
    pools = [
      {
        id: "pool-1",
        name: "Remote pool",
        kind: "agentPool",
        nodes: [node("brchen-db3", false), node("brchen-db4", true)],
        status: { state: "connected", since: "2026-11-17T00:00:00.000Z" },
        nodeStates: { "brchen-db3": state, "brchen-db4": "connected" },
        pending: 0,
        createdAt: "2026-11-17T00:00:00.000Z",
        updatedAt: "2026-11-17T00:00:00.000Z",
      },
    ];
  }

  const reports = () =>
    deliverMock.mock.calls.map(([owner, message]): [string, Record<string, unknown>] => [
      owner,
      (message as { systemMessage: Record<string, unknown> }).systemMessage,
    ]);

  test("list the nodes they can run on, and the node each one runs on", async () => {
    await useNode();
    await createSubSession("owner", { name: "UI check", brief, node: "brchen-db3" });
    await createSubSession("owner", { name: "Local fix", brief });

    const { subSessions, nodes } = await listSubSessions("owner");

    expect(nodes).toEqual([
      { name: "brchen-db3", state: "connected" },
      { name: "brchen-db4", state: "connected", draining: true },
    ]);
    expect(subSessions.map(({ name, node }) => [name, node])).toEqual([
      ["UI check", "brchen-db3"],
      ["Local fix", undefined],
    ]);
  });

  test("leave a history of who created each, where it ran, and when it closed", async () => {
    await useNode();
    await registerWorkerSession({
      type: "team",
      sessionId: "agent-riley",
      teamId: "team-1",
      createdAt: new Date(0).toISOString(),
      ephemeral: false,
      name: "Riley",
    });
    const remote = await createSubSession("agent-riley", {
      name: "UI check",
      brief,
      node: "brchen-db3",
    });
    const local = await createSubSession("owner", { name: "Local fix", brief });

    await closeSubSession("agent-riley", remote.sessionId);
    // Deleting the session itself, as the user or its owner's removal does, closes it too.
    await unregisterWorkerSession(local.sessionId);

    const history = await readSubSessionHistory(new Date(0));
    expect(
      history.map(({ createdAt: _created, closedAt, ...record }) => [record, !!closedAt]),
    ).toEqual([
      [{ sessionId: local.sessionId, ownerSessionId: "owner", name: "Local fix" }, true],
      [
        {
          sessionId: remote.sessionId,
          ownerSessionId: "agent-riley",
          teamId: "team-1",
          node: "brchen-db3",
          name: "UI check",
        },
        true,
      ],
    ]);
  });

  test("a restart tells each owner which runs it interrupted, with their briefs", async () => {
    await useNode();
    const local = await createSubSession("owner", { name: "Local fix", brief });
    const remote = await createSubSession("owner", { name: "UI check", brief, node: "brchen-db3" });
    const live = await createSubSession("owner", { name: "Still running", brief });
    await createSubSession("owner", { name: "Idle", brief });
    for (const { sessionId } of [local, remote, live]) await noteWorking(sessionId, true);
    running.add(live.sessionId);
    deliverMock.mockClear();

    await reportInterruptedSubSessions();
    await reportInterruptedSubSessions();

    const interrupted = {
      type: "sub_session_report",
      outcome: "interrupted",
      brief: renderedBrief,
    };
    expect(
      reports().sort(([, left], [, right]) =>
        String(left.sessionId).localeCompare(String(right.sessionId)),
      ),
    ).toEqual([
      [
        "owner",
        {
          ...interrupted,
          sessionId: local.sessionId,
          name: "Local fix",
          report: "Agent Teams restarted while it was working, which stopped its run.",
        },
      ],
      [
        "owner",
        {
          ...interrupted,
          sessionId: remote.sessionId,
          name: "UI check",
          report:
            "Agent Teams restarted while it was working on brchen-db3, where its run may have gone on.",
        },
      ],
    ]);
    expect((await getPersistedWorker(live.sessionId))?.metadata).toMatchObject({ working: true });
  });

  test("a run that failed while its node was out of reach comes back interrupted", async () => {
    await useNode("unreachable");
    const { sessionId } = await createSubSession("owner", {
      name: "UI check",
      brief,
      node: "brchen-db3",
    });

    await reportToOwner(sessionId, { status: "failed", error: "brchen-db3 is out of reach." });
    pools = pools.map((pool) => ({ ...pool, nodeStates: { "brchen-db3": "connected" } }));
    await reportToOwner(sessionId, { status: "failed", error: "The model refused." });

    expect(
      reports().map(([, message]) => [message.outcome, message.report, message.brief]),
    ).toEqual([
      ["interrupted", "brchen-db3 is out of reach.", renderedBrief],
      ["failed", "The model refused.", undefined],
    ]);
  });
});
