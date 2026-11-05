import { describe, expect, mock, onTestFinished, test } from "bun:test";
import { createTestDatabase } from "@/server/database";
import { SMALL_JSON_MAX_BYTES } from "@/shared/smallJson";

let currentDb: Bun.SQL | undefined;

mock.module("@/server/database", () => ({
  getStateDatabase: async (options?: { createIfMissing?: boolean }) => {
    if (!currentDb && options?.createIfMissing === false) return null;
    if (!currentDb) throw new Error("Test database has not been opened");
    return currentDb;
  },
}));

const {
  getEphemeralWorkerSessionIds,
  getPersistedWorker,
  getWorkerSessionIdsForApp,
  getWorkerSessionIdsForParent,
  registerWorkerSession,
  unregisterWorkerSession,
  WorkerDatabase,
  createWorker,
} = await import("./database");

const { getWorker, listWorkers, updateWorker, initializeWorkerMetadata } = await import("./index");

async function openWorkersTestDatabase(): Promise<void> {
  currentDb = await createTestDatabase();
  onTestFinished(async () => {
    await currentDb?.close();
    currentDb = undefined;
  });
}

describe("worker ownership", () => {
  test("public owner reads select one team without exposing another's Workers", async () => {
    await openWorkersTestDatabase();
    for (const teamId of ["a", "b"]) {
      await registerWorkerSession({
        type: "team",
        teamId,
        sessionId: teamId,
        createdAt: new Date(0).toISOString(),
        ephemeral: false,
        name: "Reviewer",
      });
    }
    const owner = { type: "team", teamId: "a" } as const;
    expect((await listWorkers(owner)).map((worker) => worker.sessionId)).toEqual(["a"]);
    expect(await getWorker("b", owner)).toBeNull();
    expect((await getWorker("b", "team"))?.name).toBe("Reviewer");
  });

  test("public detail updates preserve omitted fields and replace or clear opaque metadata", async () => {
    await openWorkersTestDatabase();
    const worker = {
      type: "inbox" as const,
      sessionId: "result",
      name: "Initial",
      createdAt: new Date(0).toISOString(),
      ephemeral: false,
      metadata: { message: "First", artifact: "report.md" },
    };
    await registerWorkerSession(worker);
    await updateWorker(worker.sessionId, { name: "Renamed" });
    expect(await getWorker(worker.sessionId, "inbox")).toEqual({ ...worker, name: "Renamed" });
    await updateWorker(worker.sessionId, { metadata: { message: "Second" } });
    expect(await getWorker(worker.sessionId, "inbox")).toEqual({
      ...worker,
      name: "Renamed",
      metadata: { message: "Second" },
    });
    expect(
      await initializeWorkerMetadata(worker.sessionId, "inbox", { error: "Late failure" }),
    ).toBe(false);
    await updateWorker(worker.sessionId, { metadata: undefined });
    expect((await getWorker(worker.sessionId, "inbox"))?.metadata).toBeUndefined();
    await expect(updateWorker("missing", { name: "Missing" })).rejects.toThrow("Worker not found");
  });

  test("initializes only absent metadata for the matching owner", async () => {
    await openWorkersTestDatabase();
    const store = new WorkerDatabase(currentDb!);
    const worker = {
      type: "inbox" as const,
      sessionId: "initialize",
      createdAt: new Date(0).toISOString(),
      ephemeral: false as const,
    };
    await store.create(worker);
    expect(await store.initializeMetadata(worker.sessionId, "app", { error: "Wrong owner" })).toBe(
      false,
    );
    expect(
      await store.initializeMetadata(worker.sessionId, "inbox", { error: "Interrupted" }),
    ).toBe(true);
    expect(
      await store.initializeMetadata(worker.sessionId, "inbox", { error: "Later failure" }),
    ).toBe(false);
    expect((await store.get(worker.sessionId))?.metadata).toEqual({ error: "Interrupted" });
    // JSON null is present metadata, distinct from an empty SQL column.
    await store.update(worker.sessionId, { metadata: null });
    expect(await store.initializeMetadata(worker.sessionId, "inbox", { error: "Unreadable" })).toBe(
      false,
    );
    expect((await store.get(worker.sessionId))?.metadata).toBeNull();
  });

  test("bounds construction and metadata updates before changing the stored record", async () => {
    await openWorkersTestDatabase();
    const store = new WorkerDatabase(currentDb!);
    const maximum = "é".repeat((SMALL_JSON_MAX_BYTES - 2) / 2);
    const oversized = `${maximum}é`;
    const worker = {
      type: "inbox" as const,
      sessionId: "bounded-metadata",
      createdAt: new Date(0).toISOString(),
      ephemeral: false as const,
    };
    await store.create({ ...worker, metadata: maximum });
    expect((await store.get(worker.sessionId))?.metadata).toBe(maximum);

    expect(() => createWorker({ type: "inbox", ephemeral: false, metadata: oversized })).toThrow(
      String(SMALL_JSON_MAX_BYTES),
    );
    await expect(
      store.update(worker.sessionId, { name: "Changed", metadata: oversized }),
    ).rejects.toThrow(String(SMALL_JSON_MAX_BYTES));
    await expect(store.initializeMetadata(worker.sessionId, "inbox", oversized)).rejects.toThrow(
      String(SMALL_JSON_MAX_BYTES),
    );

    expect(await store.get(worker.sessionId)).toEqual({ ...worker, metadata: maximum });
  });

  test("rejects malformed JSON at the SQLite boundary", async () => {
    await openWorkersTestDatabase();
    await registerWorkerSession({
      type: "inbox",
      sessionId: "valid-json",
      createdAt: new Date(0).toISOString(),
      ephemeral: false,
      metadata: { message: "Keep this" },
    });
    await expect(
      (async () => {
        await currentDb!`UPDATE workers SET metadata = ${"{invalid"} WHERE session_id = 'valid-json'`;
      })(),
    ).rejects.toThrow();
    expect((await getPersistedWorker("valid-json"))?.metadata).toEqual({ message: "Keep this" });
  });

  test("lists worker session ids for a specific parent", async () => {
    await openWorkersTestDatabase();

    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "session",
      sessionId: "agent-teams-worker-a",
      parentSessionId: "agent-teams-parent-a",
      ephemeral: false,
    });
    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "session",
      sessionId: "agent-teams-worker-b",
      parentSessionId: "agent-teams-parent-b",
      ephemeral: true,
    });
    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "file",
      sessionId: "agent-teams-worker-c",
      ephemeral: true,
      file: { kind: "session", sessionId: "agent-teams-parent-a", path: "notes.md" },
    });

    expect(await getWorkerSessionIdsForParent("agent-teams-parent-a")).toEqual([
      "agent-teams-worker-a",
      "agent-teams-worker-c",
    ]);
  });

  test("round-trips owner details, names, and metadata", async () => {
    await openWorkersTestDatabase();

    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "file",
      sessionId: "agent-teams-file-worker",
      file: { kind: "session", sessionId: "agent-teams-parent", path: "notes.md" },
      ephemeral: true,
      name: "Editor",
      metadata: { task: "Review notes" },
    });
    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "team",
      sessionId: "agent-teams-team-worker",
      teamId: "team-a",
      ephemeral: false,
      name: "Critic",
      metadata: { seenThrough: 4 },
    });

    expect(await getPersistedWorker("agent-teams-file-worker")).toEqual({
      createdAt: new Date(0).toISOString(),
      type: "file",
      sessionId: "agent-teams-file-worker",
      file: { kind: "session", sessionId: "agent-teams-parent", path: "notes.md" },
      ephemeral: true,
      name: "Editor",
      metadata: { task: "Review notes" },
    });
    expect(await getPersistedWorker("agent-teams-team-worker")).toEqual({
      createdAt: new Date(0).toISOString(),
      type: "team",
      sessionId: "agent-teams-team-worker",
      teamId: "team-a",
      ephemeral: false,
      name: "Critic",
      metadata: { seenThrough: 4 },
    });
  });

  test("selects ephemeral workers independently of their owner", async () => {
    await openWorkersTestDatabase();

    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "file",
      sessionId: "agent-teams-file-worker",
      ephemeral: true,
      file: { kind: "session", sessionId: "agent-teams-parent", path: "notes.md" },
    });
    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "app",
      sessionId: "agent-teams-app-worker",
      appId: "app-a",
      ephemeral: false,
    });
    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "session",
      sessionId: "agent-teams-session-worker",
      parentSessionId: "agent-teams-parent",
      ephemeral: true,
    });
    expect(await getEphemeralWorkerSessionIds()).toEqual([
      "agent-teams-file-worker",
      "agent-teams-session-worker",
    ]);
    expect(await getWorkerSessionIdsForApp("app-a")).toEqual(["agent-teams-app-worker"]);
  });

  test("unregisters workers and treats missing records as a no-op", async () => {
    await openWorkersTestDatabase();

    await registerWorkerSession({
      createdAt: new Date(0).toISOString(),
      type: "session",
      sessionId: "agent-teams-worker",
      parentSessionId: "agent-teams-parent",
      ephemeral: false,
    });
    await unregisterWorkerSession("agent-teams-worker");
    await unregisterWorkerSession("agent-teams-worker");

    expect(await getPersistedWorker("agent-teams-worker")).toBeNull();
  });

  test("read paths no-op when the server-state database does not exist", async () => {
    expect(await getWorkerSessionIdsForParent("agent-teams-parent")).toEqual([]);
    expect(await getWorkerSessionIdsForApp("app-a")).toEqual([]);
    expect(await getEphemeralWorkerSessionIds()).toEqual([]);
    expect(await getPersistedWorker("missing-worker")).toBeNull();
  });
});
