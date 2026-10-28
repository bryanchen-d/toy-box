import { expect, spyOn, test } from "bun:test";
import { fromJSON, toJSONAsync } from "seroval";
import { createDefaultSerovalPlugins } from "@tanstack/router-core/ssr/client";
import { isCancelledError, QueryClient, QueryObserver } from "@tanstack/react-query";
import { observeSession } from "./observeSession";
import { createInitialSessionState } from "./model/reducer";
import { applySessionEvent } from "./model/reducer";
import { createSessionEventBus } from "./server/runtime/eventBus";
import type { SessionEvent, SessionState } from "./model";
import { SessionObservationError, type StreamSessionRequest } from "./model/protocol";
import { sessionQueries } from "./queries";
import { applyWorkspaceEventToSessionQueries, recreateSessionInCache } from "./queryCache";

async function rpcError(error: Error): Promise<Error> {
  const plugins = createDefaultSerovalPlugins();
  const decoded: unknown = fromJSON(await toJSONAsync(error, { plugins }), { plugins });
  if (!(decoded instanceof Error)) throw new Error("Expected a serialized RPC error.");
  return decoded;
}

test.each(["setup", "read"])(
  "an explicit %s operation rejection surfaces once, without recovery or resubmission",
  async (stage) => {
    const controller = new AbortController();
    const rejection = await rpcError(
      stage === "setup"
        ? new TypeError("Failed to fetch")
        : new Error("Provider rejected initial creation"),
    );
    let submissions = 0;
    let refreshes = 0;
    let recoveryErrors = 0;
    await expect(
      observeSession(
        { sessionId: "test", message: { content: "once", clientId: "initial" } },
        {
          signal: controller.signal,
          stream: async () => {
            submissions++;
            if (stage === "setup") throw rejection;
            return (async function* () {
              throw rejection;
            })();
          },
          refresh: async () => {
            refreshes++;
            return createInitialSessionState();
          },
          adopt: () => {
            throw new Error("must not adopt");
          },
          apply: () => {
            throw new Error("must not apply");
          },
          onError: () => {
            recoveryErrors++;
            controller.abort();
          },
        },
      ),
    ).rejects.toBe(rejection);
    expect(submissions).toBe(1);
    expect(refreshes).toBe(0);
    expect(recoveryErrors).toBe(0);
  },
);

test.each(["adopt", "apply", "refresh"])(
  "%s failures are not swallowed by transport recovery",
  async (phase) => {
    const controller = new AbortController();
    const failure = new Error(
      phase === "refresh" ? "Session not found: deleted" : "Programming error",
    );
    const loss = await rpcError(new SessionObservationError("expired replay"));
    let recoveries = 0;
    let subscriptions = 0;
    await expect(
      observeSession(
        { sessionId: "test" },
        {
          signal: controller.signal,
          refresh: async () => {
            if (phase === "refresh") throw failure;
            return createInitialSessionState();
          },
          stream: async () => {
            if (++subscriptions === 1 && phase !== "apply") throw loss;
            return (async function* () {
              yield { type: "delta", content: "live" } as const;
            })();
          },
          adopt: () => {
            if (phase === "adopt") throw failure;
          },
          apply: () => {
            if (phase === "apply") throw failure;
          },
          onError: (error) => {
            expect(error).toBe(loss);
            recoveries++;
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(recoveries).toBe(phase === "apply" ? 0 : 1);
  },
);

test.each(["iterator", "next"])(
  "synchronous RPC %s observation loss remains recoverable",
  async (stage) => {
    const controller = new AbortController();
    const loss = await rpcError(new SessionObservationError("expired replay"));
    let recoveries = 0;
    const iterator: AsyncIterableIterator<SessionEvent> = {
      [Symbol.asyncIterator]() {
        if (stage === "iterator") throw loss;
        return this;
      },
      next: () => {
        throw loss;
      },
    };
    await observeSession(
      { sessionId: "test" },
      {
        signal: controller.signal,
        stream: async () => iterator,
        refresh: async () => {
          throw new Error("cancelled retry must not refresh");
        },
        adopt: () => {
          throw new Error("must not adopt");
        },
        apply: () => {
          throw new Error("must not apply");
        },
        onError: () => {
          recoveries++;
          controller.abort();
        },
      },
    );
    expect(recoveries).toBe(1);
  },
);

test("recovers a constant-live observation from an adopted snapshot, never resending the first message", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const controller = new AbortController();
  const requests: StreamSessionRequest[] = [];
  const order: string[] = [];
  const applied: SessionEvent[] = [];
  const snapshot = createInitialSessionState({ lastSeenEventId: 42 });
  try {
    const received = await observeSession(
      { sessionId: "test", message: { content: "once", clientId: "first" } },
      {
        signal: controller.signal,
        stream: async (request, transport) => {
          requests.push(request);
          if (requests.length === 1) await transport.fetch("http://localhost");
          order.push("resume");
          return (async function* () {
            yield { type: "delta", content: "after snapshot", eventId: 43 } as const;
            yield { type: "end", reason: "idle", eventId: 44 } as const;
          })();
        },
        refresh: async () => {
          order.push("snapshot");
          return snapshot;
        },
        adopt: (value) => {
          expect(value).toBe(snapshot);
          order.push("adopt");
        },
        apply: (event) => applied.push(event),
        onError: () => order.push("error"),
      },
    );
    expect(order).toEqual(["error", "snapshot", "adopt", "resume"]);
    expect(requests).toEqual([
      { sessionId: "test", message: { content: "once", clientId: "first" } },
      { sessionId: "test", mode: undefined, afterEventId: 42 },
    ]);
    expect(applied.map((event) => event.type)).toEqual(["delta", "end"]);
    expect(received).toBe(true);
  } finally {
    fetch.mockRestore();
  }
});

test("abort (including hidden/unmounted panes) stops retry timers immediately", async () => {
  const controller = new AbortController();
  let attempts = 0;
  let refreshes = 0;
  await observeSession(
    { sessionId: "test", mode: "passive" },
    {
      signal: controller.signal,
      stream: async () => {
        attempts++;
        throw await rpcError(new SessionObservationError("overflow"));
      },
      refresh: async () => {
        refreshes++;
        return createInitialSessionState();
      },
      adopt: () => {
        throw new Error("must not adopt");
      },
      apply: () => {
        throw new Error("must not apply");
      },
      onError: () => queueMicrotask(() => controller.abort()),
    },
  );
  expect(attempts).toBe(1);
  expect(refreshes).toBe(0);
});

test("an aborted snapshot cannot publish or reconnect, and passive mode survives recovery", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await observeSession(
    { sessionId: "test", mode: "passive" },
    {
      signal: controller.signal,
      stream: async () => {
        attempts++;
        throw await rpcError(new SessionObservationError("expired replay"));
      },
      refresh: async () => {
        controller.abort();
        return createInitialSessionState({ lastSeenEventId: 77 });
      },
      adopt: () => {
        throw new Error("must not adopt");
      },
      apply: () => {
        throw new Error("must not apply");
      },
      onError: () => {},
    },
  );
  expect(attempts).toBe(1);
});

test("clean completion has no retry and releases the iterator", async () => {
  let returned = 0;
  let transportSignal: AbortSignal | undefined;
  const iterator: AsyncIterableIterator<SessionEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: async () => ({ done: true, value: undefined }),
    return: async () => {
      returned++;
      return { done: true, value: undefined };
    },
  };
  const result = await observeSession(
    { sessionId: "test" },
    {
      signal: new AbortController().signal,
      stream: async (_request, transport) => {
        transportSignal = transport.signal;
        return iterator;
      },
      refresh: async () => {
        throw new Error("must not refresh");
      },
      adopt: () => {
        throw new Error("must not adopt");
      },
      apply: () => {
        throw new Error("must not apply");
      },
      onError: () => {
        throw new Error("must not retry");
      },
    },
  );
  expect(result).toBe(false);
  expect(returned).toBe(1);
  expect(transportSignal?.aborted).toBe(false);
});

test("abort immediately releases an outstanding read even when the RPC iterator stays pending", async () => {
  const controller = new AbortController();
  let release!: (event: IteratorResult<SessionEvent>) => void;
  let applied = 0;
  const iterator: AsyncIterableIterator<SessionEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => {
      queueMicrotask(() => controller.abort());
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    return: () => {
      throw new Error("queued return must not block cancellation");
    },
  };
  expect(
    await observeSession(
      { sessionId: "test" },
      {
        signal: controller.signal,
        stream: async () => iterator,
        refresh: async () => {
          throw new Error("no retry");
        },
        adopt: () => {},
        apply: () => {
          applied++;
        },
        onError: () => {
          throw new Error("abort is not an error");
        },
      },
    ),
  ).toBe(false);
  release({ done: false, value: { type: "delta", content: "abandoned read" } });
  await Bun.sleep(0);
  expect(applied).toBe(0);
});

test("a missing snapshot after observation loss rejects instead of spinning recovery", async () => {
  const failure = await rpcError(new Error("Session not found: deleted"));
  let subscriptions = 0;
  let refreshes = 0;
  let losses = 0;
  await expect(
    observeSession(
      { sessionId: "test" },
      {
        signal: new AbortController().signal,
        stream: async () => {
          subscriptions++;
          throw await rpcError(new SessionObservationError("expired replay"));
        },
        refresh: async () => {
          refreshes++;
          throw failure;
        },
        adopt: () => {
          throw new Error("must not adopt");
        },
        apply: () => {
          throw new Error("must not apply");
        },
        onError: () => {
          losses++;
        },
      },
    ),
  ).rejects.toBe(failure);
  expect({ subscriptions, refreshes, losses }).toEqual({
    subscriptions: 1,
    refreshes: 1,
    losses: 1,
  });
});

test("two panes share one Query-owned snapshot; aborting one preserves the other's read and newer cache", async () => {
  const client = new QueryClient();
  const a = new AbortController();
  const b = new AbortController();
  let release!: (snapshot: SessionState) => void;
  let querySignal!: AbortSignal;
  let reads = 0;
  const query = {
    ...sessionQueries.detail("shared"),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      reads++;
      querySignal = signal;
      return new Promise<SessionState>((resolve) => {
        release = resolve;
      });
    },
  };
  const firstObserver = new QueryObserver(client, { ...query, enabled: false });
  const secondObserver = new QueryObserver(client, { ...query, enabled: false });
  const unsubscribeA = firstObserver.subscribe(() => {});
  const unsubscribeB = secondObserver.subscribe(() => {});
  const adopted: string[] = [];
  const loss = await rpcError(new SessionObservationError("expired replay"));
  let refreshes = 0;
  let ready!: () => void;
  const bothRefreshing = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const observe = (pane: string, controller: AbortController) => {
    let subscriptions = 0;
    return observeSession(
      { sessionId: "shared", mode: "passive" },
      {
        signal: controller.signal,
        refresh: () => {
          if (++refreshes === 2) ready();
          return client.fetchQuery(query);
        },
        adopt: () => {
          adopted.push(pane);
        },
        stream: async (request) => {
          if (++subscriptions === 1) throw loss;
          expect(request.afterEventId).toBe(42);
          return undefined;
        },
        apply: () => {
          throw new Error("no events");
        },
        onError: (error) => {
          expect(error).toBe(loss);
        },
      },
    );
  };
  try {
    const first = observe("a", a);
    const second = observe("b", b);
    await bothRefreshing;
    const newer = client.setQueryData(
      query.queryKey,
      createInitialSessionState({ lastSeenEventId: 41 }),
    );
    a.abort();
    expect(await first).toBe(false);
    unsubscribeA();
    expect(querySignal.aborted).toBe(false);
    expect(client.getQueryData(query.queryKey)).toBe(newer);
    release(createInitialSessionState({ lastSeenEventId: 42 }));
    expect(await second).toBe(false);
    expect(reads).toBe(1);
    expect(adopted).toEqual(["b"]);
  } finally {
    a.abort();
    b.abort();
    unsubscribeA();
    unsubscribeB();
    client.clear();
  }
});

test.each(["deleted", "replaced"])(
  "a %s entity still cancels its shared Query read and cannot be resurrected",
  async (lifecycle) => {
    const client = new QueryClient();
    const controller = new AbortController();
    const key = sessionQueries.detail("retired").queryKey;
    client.setQueryData(key, createInitialSessionState({ lastSeenEventId: 7 }));
    let release!: (snapshot: SessionState) => void;
    let querySignal!: AbortSignal;
    let adopted = 0;
    let reads = 0;
    let subscriptions = 0;
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const loss = await rpcError(new SessionObservationError("expired replay"));
    const pending = observeSession(
      { sessionId: "retired", afterEventId: 7 },
      {
        signal: controller.signal,
        refresh: () =>
          client.fetchQuery({
            ...sessionQueries.detail("retired"),
            queryFn: ({ signal }) => {
              reads++;
              querySignal = signal;
              return new Promise<SessionState>((resolve) => {
                release = resolve;
                ready();
              });
            },
          }),
        adopt: () => {
          adopted++;
        },
        stream: async () => {
          if (++subscriptions > 1) throw new Error("must not resubscribe");
          throw loss;
        },
        apply: () => {
          throw new Error("no events");
        },
        onError: (error) => {
          expect(error).toBe(loss);
        },
      },
    ).catch((error: unknown) => error);
    try {
      await reading;
      if (lifecycle === "deleted") {
        applyWorkspaceEventToSessionQueries(client, {
          type: "session.deleted",
          sessionId: "retired",
        });
      } else {
        await recreateSessionInCache(client, "retired", {
          content: "replacement",
          clientId: "new",
        });
      }
      const retired = client.getQueryData(key);
      expect(querySignal.aborted).toBe(true);
      expect(isCancelledError(await pending)).toBe(true);
      controller.abort();
      release(createInitialSessionState({ lastSeenEventId: 100 }));
      await Bun.sleep(0);
      expect(client.getQueryData(key)).toBe(retired);
      expect(adopted).toBe(0);
      expect(reads).toBe(1);
      expect(subscriptions).toBe(1);
    } finally {
      controller.abort();
      client.clear();
    }
  },
);

test("a late read from a failed attempt cannot overwrite snapshot recovery", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
    ),
  );
  let release!: (event: IteratorResult<SessionEvent>) => void;
  let attempts = 0;
  const applied: string[] = [];
  let adopted = false;
  try {
    await observeSession(
      { sessionId: "test" },
      {
        signal: new AbortController().signal,
        stream: async (_request, transport) => {
          if (++attempts === 1) {
            const response = await transport.fetch("http://localhost");
            void response.text().catch(() => {});
            const iterator: AsyncIterableIterator<SessionEvent> = {
              [Symbol.asyncIterator]() {
                return this;
              },
              next: () => {
                queueMicrotask(() => body.error(new Error("wire lost")));
                return new Promise((resolve) => {
                  release = resolve;
                });
              },
              return: () => {
                throw new Error("must not await abandoned return");
              },
            };
            return iterator;
          }
          expect(adopted).toBe(true);
          release({ done: false, value: { type: "delta", content: "abandoned" } });
          return (async function* () {
            yield { type: "delta", content: "fresh" } as const;
          })();
        },
        refresh: async () => createInitialSessionState(),
        adopt: () => {
          adopted = true;
        },
        apply: (event) => {
          if (event.type === "delta") applied.push(event.content);
        },
        onError: () => {},
      },
    );
    await Bun.sleep(0);
    expect(applied).toEqual(["fresh"]);
  } finally {
    fetch.mockRestore();
  }
});

test.each(["error", "eof"])(
  "wire %s releases a stranded RPC iterator without awaiting its queued return",
  async (failure) => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            if (failure === "error") controller.error(new Error("wire lost"));
            else controller.close();
          },
        }),
      ),
    );
    let attempts = 0;
    let failedSignal: AbortSignal | undefined;
    let adopted = false;
    try {
      await observeSession(
        { sessionId: "test" },
        {
          signal: new AbortController().signal,
          stream: async (_request, transport) => {
            if (++attempts === 1) {
              failedSignal = transport.signal;
              const response = await transport.fetch("http://localhost");
              // Model the installed decoder: logs/catches wire loss, strands next().
              void response.text().catch(() => {});
              const iterator: AsyncIterableIterator<SessionEvent> = {
                [Symbol.asyncIterator]() {
                  return this;
                },
                next: () => new Promise<IteratorResult<SessionEvent>>(() => {}),
                return: () => {
                  throw new Error("queued return must not be awaited");
                },
              };
              return iterator;
            }
            expect(failedSignal?.aborted).toBe(true);
            expect(adopted).toBe(true);
            return undefined;
          },
          refresh: async () => createInitialSessionState(),
          adopt: () => {
            adopted = true;
          },
          apply: () => {
            throw new Error("no events");
          },
          onError: () => {},
        },
      );
      expect(attempts).toBe(2);
    } finally {
      fetch.mockRestore();
    }
  },
);

test("expired replay heals through the existing reducer before passive cursor resume", async () => {
  const bus = createSessionEventBus(1);
  let state = createInitialSessionState();
  const emit = (event: SessionEvent) => {
    state = applySessionEvent(state, bus.publish(event));
  };
  emit({ type: "delta", content: "before" });
  const cursor = state.lastSeenEventId;
  emit({ type: "delta", content: " missed" });
  emit({ type: "delta", content: " during disconnect" });
  let visible = createInitialSessionState({ lastSeenEventId: cursor });
  let attempts = 0;
  await observeSession(
    { sessionId: "test", mode: "passive", afterEventId: cursor },
    {
      signal: new AbortController().signal,
      stream: async (request) => {
        attempts++;
        const subscription = bus.subscribe(
          request.afterEventId,
          "mode" in request ? request.mode : undefined,
        );
        if (attempts === 2) {
          expect(visible).toBe(state);
          expect(bus.hasActiveSubscribers).toBe(false);
          emit({ type: "delta", content: " after resume" });
          bus.close();
        }
        return subscription;
      },
      refresh: async () => state,
      adopt: (snapshot) => {
        visible = snapshot;
      },
      apply: (event) => {
        visible = applySessionEvent(visible, event);
      },
      onError: () => {},
    },
  );
  expect(attempts).toBe(2);
  expect(visible).toEqual(state);
  expect(visible.messages[0]?.content).toBe("before missed during disconnect after resume");
});
