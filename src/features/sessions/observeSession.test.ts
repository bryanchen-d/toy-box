import { expect, onTestFinished, spyOn, test } from "bun:test";
import { fromJSON, toJSONAsync } from "seroval";
import { createDefaultSerovalPlugins } from "@tanstack/router-core/ssr/client";
import { isCancelledError, QueryClient, QueryObserver } from "@tanstack/react-query";
import { observeSession, sessionFetch } from "./observeSession";
import { readSessionEvents } from "./readSessionEvents";
import { createInitialSessionView, applySessionViewEvent, type SessionView } from "./model/view";
import { createSessionEventBus } from "./server/runtime/eventBus";
import type { SessionEvent } from "./model";
import { SessionObservationError, type StreamSessionRequest } from "./model/protocol";
import { sessionQueries } from "./queries";
import { applyWorkspaceEventToSessionQueries, recreateSessionInCache } from "./queryCache";

async function rpcError(error: Error): Promise<Error> {
  const plugins = createDefaultSerovalPlugins();
  const decoded: unknown = fromJSON(await toJSONAsync(error, { plugins }), {
    plugins,
  });
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
        {
          sessionId: "test",
          message: { content: "once", clientId: "initial" },
        },
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
            return createInitialSessionView();
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
            return createInitialSessionView();
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
  const snapshot = createInitialSessionView({ lastSeenEventId: 42 });
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
            yield {
              type: "delta",
              content: "after snapshot",
              eventId: 43,
            } as const;
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
        return createInitialSessionView();
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
        return createInitialSessionView({ lastSeenEventId: 77 });
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
      stream: async () => iterator,
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
});

test("abort rejects the outstanding native read and ends observation without recovery", async () => {
  const controller = new AbortController();
  let applied = 0;
  const result = await observeSession(
    { sessionId: "test" },
    {
      signal: controller.signal,
      stream: async (_request, transport) => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<SessionEvent>>((_, reject) => {
              queueMicrotask(() => controller.abort());
              transport.signal.addEventListener("abort", () => reject(transport.signal.reason));
            }),
        }),
      }),
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
  );
  expect(result).toBe(false);
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
  let release!: (snapshot: SessionView) => void;
  let querySignal!: AbortSignal;
  let reads = 0;
  const query = {
    ...sessionQueries.detail("shared"),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      reads++;
      querySignal = signal;
      return new Promise<SessionView>((resolve) => {
        release = resolve;
      });
    },
  };
  const firstObserver = new QueryObserver(client, { ...query, enabled: false });
  const secondObserver = new QueryObserver(client, {
    ...query,
    enabled: false,
  });
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
      createInitialSessionView({ lastSeenEventId: 41 }),
    );
    a.abort();
    expect(await first).toBe(false);
    unsubscribeA();
    expect(querySignal.aborted).toBe(false);
    expect(client.getQueryData(query.queryKey)).toBe(newer);
    release(createInitialSessionView({ lastSeenEventId: 42 }));
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
    client.setQueryData(key, createInitialSessionView({ lastSeenEventId: 7 }));
    let release!: (snapshot: SessionView) => void;
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
              return new Promise<SessionView>((resolve) => {
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
      release(createInitialSessionView({ lastSeenEventId: 100 }));
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

test.each(["error", "eof"])(
  "raw wire %s without a terminal event recovers from a snapshot and resumes its cursor",
  async (failure) => {
    const requests: StreamSessionRequest[] = [];
    const applied: string[] = [];
    let adopted = false;
    const body = (final: boolean) => {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(final ? { type: "end", reason: "idle" } : { type: "delta", content: "x" })}\n\n`,
              ),
            );
          } else if (failure === "error" && !final) controller.error(new Error("wire lost"));
          else controller.close();
        },
      });
    };
    await observeSession(
      { sessionId: "test", message: { content: "once", clientId: "first" } },
      {
        signal: new AbortController().signal,
        stream: async (request) => {
          requests.push(request);
          if (requests.length > 1) expect(adopted).toBe(true);
          return readSessionEvents(new Response(body(requests.length > 1)));
        },
        refresh: async () => createInitialSessionView({ lastSeenEventId: 9 }),
        adopt: () => {
          adopted = true;
        },
        apply: (event) => applied.push(event.type),
        onError: () => {},
      },
    );
    expect(applied).toEqual(["delta", "end"]);
    expect(requests).toEqual([
      { sessionId: "test", message: { content: "once", clientId: "first" } },
      { sessionId: "test", mode: undefined, afterEventId: 9 },
    ]);
  },
);

test("expired replay heals through the existing reducer before passive cursor resume", async () => {
  const bus = createSessionEventBus(1);
  let state = createInitialSessionView();
  const emit = (event: SessionEvent) => {
    state = applySessionViewEvent(state, bus.publish(event));
  };
  emit({ type: "delta", content: "before" });
  const cursor = state.lastSeenEventId;
  emit({ type: "delta", content: " missed" });
  emit({ type: "delta", content: " during disconnect" });
  let visible = createInitialSessionView({ lastSeenEventId: cursor });
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
        visible = applySessionViewEvent(visible, event);
      },
      onError: () => {},
    },
  );
  expect(attempts).toBe(2);
  expect(visible).toEqual(state);
  expect(visible.messages[0]?.content).toBe("before missed during disconnect after resume");
});

test("a queued event cannot publish after observation is aborted", async () => {
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const read = Promise.withResolvers<IteratorResult<SessionEvent>>();
  const applied: SessionEvent[] = [];
  const iterator: AsyncIterableIterator<SessionEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      ready.resolve();
      return read.promise;
    },
    return: async () => ({ done: true, value: undefined }),
  };
  const observation = observeSession(
    { sessionId: "test" },
    {
      signal: controller.signal,
      stream: async () => iterator,
      refresh: async () => {
        throw new Error("must not refresh");
      },
      adopt: () => {
        throw new Error("must not adopt");
      },
      apply: (event) => applied.push(event),
      onError: () => {
        throw new Error("abort is not an error");
      },
    },
  );
  await ready.promise;
  controller.abort();
  read.resolve({ done: false, value: { type: "delta", content: "late" } });
  expect(await observation).toBe(false);
  expect(applied).toEqual([]);
});

test("an already-aborted snapshot wait leaves the shared read alive without adopting it", async () => {
  const controller = new AbortController();
  const shared = Promise.withResolvers<SessionView>();
  const snapshot = createInitialSessionView();
  let adopted = false;
  onTestFinished(() => shared.resolve(snapshot));
  const observation = observeSession(
    { sessionId: "test" },
    {
      signal: controller.signal,
      stream: async () => {
        throw new SessionObservationError("expired replay");
      },
      refresh: () => {
        controller.abort();
        return shared.promise;
      },
      adopt: () => {
        adopted = true;
      },
      apply: () => {
        throw new Error("must not apply");
      },
      onError: () => {},
    },
  );
  expect(await observation).toBe(false);
  expect(adopted).toBe(false);
  shared.resolve(snapshot);
  expect(await shared.promise).toBe(snapshot);
});

test("no-live responses do not try to read a browser-exposed 204 body", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  Object.defineProperty(response, "status", { value: 204 });
  const read = spyOn(response.body!, "getReader").mockImplementation(() => {
    throw new Error("A 204 response has no event stream.");
  });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response);
  try {
    expect(readSessionEvents(await sessionFetch("http://localhost"))).toBeUndefined();
    expect(cancelled).toBe(true);
  } finally {
    fetch.mockRestore();
    read.mockRestore();
  }
});
