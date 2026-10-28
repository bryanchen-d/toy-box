import { beforeEach, describe, expect, mock, onTestFinished, spyOn, test } from "bun:test";
import * as providers from "../providers";
import { deleteSessionFiles, writeSessionArtifact } from "../artifacts";
import type { SessionEvent, SessionState } from "@sessions/model";
import { createInitialSessionState } from "@sessions/model/reducer";
import { projectSessionHistory, projectSessionView } from "@sessions/model/view";
import {
  cacheSnapshot,
  evictCachedSnapshot,
  getCachedSnapshot,
  hasCachedSnapshot,
  isCachedSnapshotFresh,
  loadSessionSnapshot,
  refreshSessionSnapshot,
  retainSessionSnapshots,
} from "@sessions/server/state/snapshots";

function snapshot(sessionId: string): SessionState {
  return createInitialSessionState({
    messages: [{ role: "assistant", content: `final response for ${sessionId}` }],
  });
}

describe("cached snapshot freshness", () => {
  const entry = { snapshot: snapshot("A"), capturedAt: 1_000_000 };

  test("serves recent snapshots only while the provider confirms their history", () => {
    expect(isCachedSnapshotFresh(entry, true, entry.capturedAt + 60_000)).toBe(true);
    expect(isCachedSnapshotFresh(entry, false, entry.capturedAt + 60_000)).toBe(false);
  });
  test("expires retained history after the cache TTL", () => {
    expect(isCachedSnapshotFresh(entry, true, entry.capturedAt + 25 * 60 * 60 * 1000)).toBe(false);
  });
});

describe.serial("snapshot cache", () => {
  beforeEach(async () => {
    await clearSnapshotCache();
  });

  test("cold and cached snapshots derive artifacts from current files", async () => {
    const sessionId = `toy-box-test-${crypto.randomUUID()}`;
    spyOn(providers, "isHistoryCurrent").mockResolvedValue(true);
    onTestFinished(async () => {
      mock.restore();
      evictCachedSnapshot(sessionId);
      await deleteSessionFiles(sessionId);
    });
    await writeSessionArtifact(sessionId, "current.html", "Current artifact");
    await writeSessionArtifact(sessionId, "summary.brief", "Current brief");
    await writeSessionArtifact(sessionId, "legacy.intent", "Unsupported legacy artifact");
    await withProviderHistory(async () => {
      expect((await loadSessionSnapshot(sessionId)).artifacts.map(({ path }) => path)).toEqual([
        "current.html",
        "summary.brief",
      ]);
      await deleteSessionFiles(sessionId);
      expect((await getCachedSnapshot(sessionId))?.artifacts).toEqual([]);
      evictCachedSnapshot(sessionId);
      expect((await loadSessionSnapshot(sessionId)).artifacts).toEqual([]);
    }, [{ type: "assistant_message", content: "Created deleted.md" }]);
  });

  test("stores and serves snapshots as private copies", async () => {
    spyOn(providers, "isHistoryCurrent").mockResolvedValue(true);
    onTestFinished(() => {
      mock.restore();
      evictCachedSnapshot("snapshot-cache-test-clone");
    });

    const original = snapshot("snapshot-cache-test-clone");
    cacheSnapshot("snapshot-cache-test-clone", original);

    // Mutating the caller's object after caching must not reach the cache...
    original.messages[0]! = { role: "assistant", content: "mutated by the producer" };
    const served = await getCachedSnapshot("snapshot-cache-test-clone");
    expect(served?.messages[0]).toEqual({
      role: "assistant",
      content: "final response for snapshot-cache-test-clone",
    });

    // ...and mutating a served snapshot (e.g. a snapshot-seeded stream's late
    // tool completion) must not corrupt what the cache serves next.
    served!.messages[0]! = { role: "assistant", content: "mutated by a reader" };
    const servedAgain = await getCachedSnapshot("snapshot-cache-test-clone");
    expect(servedAgain?.messages[0]).toEqual({
      role: "assistant",
      content: "final response for snapshot-cache-test-clone",
    });
  });

  test("eviction removes a session's snapshot", () => {
    cacheSnapshot("snapshot-cache-test-evicted", snapshot("snapshot-cache-test-evicted"));
    evictCachedSnapshot("snapshot-cache-test-evicted");

    expect(hasCachedSnapshot("snapshot-cache-test-evicted")).toBe(false);
  });

  test("hot projected reads clone only selected messages and preserve private metadata copies", async () => {
    const id = "snapshot-projected-copy";
    spyOn(providers, "isHistoryCurrent").mockResolvedValue(true);
    onTestFinished(() => {
      mock.restore();
      evictCachedSnapshot(id);
    });
    const original = createInitialSessionState({
      messages: Array.from({ length: 5271 }, (_, index) => ({ role: "user", content: `${index}` })),
      todos: [{ id: "task", title: "Original", status: "done" }],
      contextUsage: { tokens: 123, tokenWindow: 456 },
    });
    cacheSnapshot(id, original);
    const clone = spyOn(globalThis, "structuredClone");
    const view = (await getCachedSnapshot(id, projectSessionView))!;
    expect(clone.mock.calls).toHaveLength(1);
    expect(clone.mock.calls[0]?.[0]).toMatchObject({ messageCount: 5271, messageOffset: 5221 });
    expect(view.messages).toHaveLength(50);
    view.messages[0] = { role: "user", content: "Mutated" };
    view.todos[0]!.title = "Mutated";
    const again = (await getCachedSnapshot(id, projectSessionView))!;
    expect(again.messages[0]?.content).toBe("5221");
    expect(again.todos[0]?.title).toBe("Original");
    expect(again.contextUsage).toEqual({ tokens: 123, tokenWindow: 456 });
    expect((await getCachedSnapshot(id))?.messages).toHaveLength(5271);
  });

  test("concurrent cold projected reads share replay but never share returned values", async () => {
    const id = "snapshot-projected-cold";
    const pending = Promise.withResolvers<SessionEvent[]>();
    const history = spyOn(providers, "readSessionHistory").mockReturnValue(pending.promise);
    spyOn(providers, "isHistoryCurrent").mockResolvedValue(true);
    onTestFinished(() => {
      mock.restore();
      evictCachedSnapshot(id);
    });
    const first = loadSessionSnapshot(id, (state) => projectSessionHistory(state, 0));
    const second = loadSessionSnapshot(id, (state) => projectSessionHistory(state, 0));
    await Bun.sleep(0);
    expect(history).toHaveBeenCalledTimes(1);
    pending.resolve([{ type: "user_message", content: "Original" }]);
    const [a, b] = await Promise.all([first, second]);
    a.messages[0] = { role: "user", content: "Changed" };
    expect(b.messages[0]?.content).toBe("Original");
  });

  test("eviction fences an in-flight replay from restoring the deleted cache entry", async () => {
    const id = "snapshot-projected-evicted";
    const pending = Promise.withResolvers<SessionEvent[]>();
    spyOn(providers, "readSessionHistory").mockReturnValue(pending.promise);
    onTestFinished(() => {
      mock.restore();
      evictCachedSnapshot(id);
    });
    const read = loadSessionSnapshot(id, projectSessionView);
    await Bun.sleep(0);
    evictCachedSnapshot(id);
    pending.resolve([{ type: "user_message", content: "Obsolete" }]);
    await read;
    expect(hasCachedSnapshot(id)).toBe(false);
  });

  test("a completed turn captured during native replay wins even after its runtime is gone", async () => {
    const id = "snapshot-completed-turn-race";
    const pending = Promise.withResolvers<SessionEvent[]>();
    spyOn(providers, "readSessionHistory").mockReturnValue(pending.promise);
    spyOn(providers, "isHistoryCurrent").mockResolvedValue(true);
    onTestFinished(() => {
      mock.restore();
      evictCachedSnapshot(id);
    });
    const read = loadSessionSnapshot(id, projectSessionView);
    await Bun.sleep(0);
    cacheSnapshot(
      id,
      createInitialSessionState({
        messages: [{ role: "assistant", content: "Completed while history was reading" }],
        lastSeenEventId: 99,
      }),
    );
    pending.resolve([{ type: "assistant_message", content: "Old native history" }]);
    expect(await read).toMatchObject({
      messages: [{ role: "assistant", content: "Completed while history was reading" }],
      lastSeenEventId: 99,
    });
  });

  test("rotates out the oldest entry beyond the cap", () => {
    for (let index = 0; index <= 10; index++) {
      cacheSnapshot(`rotate-${index}`, snapshot(`rotate-${index}`));
    }

    expect(hasCachedSnapshot("rotate-0")).toBe(false);
    expect(hasCachedSnapshot("rotate-1")).toBe(true);
    expect(hasCachedSnapshot("rotate-10")).toBe(true);
  });

  test("re-caching a session refreshes its rotation slot", () => {
    for (let index = 0; index <= 9; index++) {
      cacheSnapshot(`refresh-${index}`, snapshot(`refresh-${index}`));
    }

    // A fresh capture for the oldest entry moves it to the back of the
    // rotation, so the next insert evicts the second-oldest instead.
    cacheSnapshot("refresh-0", snapshot("refresh-0"));
    cacheSnapshot("refresh-10", snapshot("refresh-10"));

    expect(hasCachedSnapshot("refresh-1")).toBe(false);
    expect(hasCachedSnapshot("refresh-0")).toBe(true);
    expect(hasCachedSnapshot("refresh-10")).toBe(true);
  });

  test("drops entries whose session has no event log on disk", async () => {
    spyOn(providers, "isHistoryCurrent").mockResolvedValue(false);
    onTestFinished(() => mock.restore());
    const sessionId = "snapshot-cache-test-missing-log";
    cacheSnapshot(sessionId, snapshot(sessionId));

    expect(await getCachedSnapshot(sessionId)).toBeUndefined();
    expect(hasCachedSnapshot(sessionId)).toBe(false);
  });

  test("history rebuilds keep the last reported context usage until an explicit refresh", async () => {
    spyOn(providers, "isHistoryCurrent").mockResolvedValue(false);
    const sessionId = "snapshot-cache-test-context-usage";
    onTestFinished(() => {
      mock.restore();
      evictCachedSnapshot(sessionId);
    });
    const contextUsage = { tokens: 41_000, tokenWindow: 258_400 };
    cacheSnapshot(sessionId, { ...snapshot(sessionId), contextUsage });

    await withProviderHistory(async () => {
      expect((await loadSessionSnapshot(sessionId)).contextUsage).toEqual(contextUsage);
      expect((await refreshSessionSnapshot(sessionId)).contextUsage).toBeUndefined();
    });
  });

  test("retaining warms a cold session and keeps its slot through rotation", async () => {
    await withProviderHistory(async () => {
      await retainSessionSnapshots(["retained-0"]);
      expect(hasCachedSnapshot("retained-0")).toBe(true);

      for (let index = 0; index <= 10; index++) {
        cacheSnapshot(`transient-${index}`, snapshot(`transient-${index}`));
      }

      expect(hasCachedSnapshot("retained-0")).toBe(true);
      // The cap still governs the transient tail around it.
      expect(hasCachedSnapshot("transient-0")).toBe(false);
      expect(hasCachedSnapshot("transient-10")).toBe(true);
    });
  });

  test("replacing the retained set returns the previous sessions to rotation", async () => {
    await withProviderHistory(async () => {
      await retainSessionSnapshots(["released-0"]);
      await retainSessionSnapshots([]);

      for (let index = 0; index <= 10; index++) {
        cacheSnapshot(`churn-${index}`, snapshot(`churn-${index}`));
      }

      expect(hasCachedSnapshot("released-0")).toBe(false);
    });
  });
});

/** Keep snapshot replay local to the supplied canonical provider history. */
async function withProviderHistory(
  run: () => Promise<void>,
  events: SessionEvent[] = [],
): Promise<void> {
  const history = spyOn(providers, "readSessionHistory").mockResolvedValue(events);

  try {
    await run();
  } finally {
    history.mockRestore();
  }
}

async function clearSnapshotCache(): Promise<void> {
  // Retained entries are exempt from rotation, so release them before flushing.
  await retainSessionSnapshots([]);

  const resetSessionIds = Array.from(
    { length: 10 },
    (_, index) => `snapshot-cache-test-reset-${index}`,
  );

  for (const sessionId of resetSessionIds) {
    cacheSnapshot(sessionId, snapshot(sessionId));
  }

  for (const sessionId of resetSessionIds) {
    evictCachedSnapshot(sessionId);
  }
}
