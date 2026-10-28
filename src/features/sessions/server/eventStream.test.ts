import { expect, spyOn, test } from "bun:test";
import type { SessionEvent } from "@sessions/model";
import { createSessionEventResponse } from "./eventStream";
import { createSessionEventBus } from "./runtime/eventBus";

const decoder = new TextDecoder();

test("quiet sessions still answer immediately with the SSE prelude", async () => {
  const bus = createSessionEventBus(10);
  const response = createSessionEventResponse(new Request("http://localhost"), bus.subscribe());
  const reader = response.body!.getReader();
  expect(decoder.decode((await reader.read()).value)).toBe("retry: 1000\n\n");
  await reader.cancel();
});

test("a normal end closes the response and releases the subscriber", async () => {
  const bus = createSessionEventBus(10);
  const response = createSessionEventResponse(new Request("http://localhost"), bus.subscribe());
  bus.publish({ type: "delta", content: "a" });
  bus.publish({ type: "end", reason: "idle" });
  bus.close();
  const text = await response.text();
  expect(text.match(/^data: /gm)).toHaveLength(2);
  expect(bus.hasActiveSubscribers).toBe(false);
});

test("a client disconnect releases the subscriber immediately while a read is pending", async () => {
  const bus = createSessionEventBus(10);
  const controller = new AbortController();
  const response = createSessionEventResponse(
    new Request("http://localhost", { signal: controller.signal }),
    bus.subscribe(),
  );
  const reader = response.body!.getReader();
  await reader.read();
  expect(bus.hasActiveSubscribers).toBe(true);
  controller.abort();
  await reader.read().catch(() => {});
  expect(bus.hasActiveSubscribers).toBe(false);
});

test("an already-aborted request does not leak its subscriber", () => {
  const bus = createSessionEventBus(10);
  createSessionEventResponse(
    new Request("http://localhost", { signal: AbortSignal.abort() }),
    bus.subscribe(),
  );
  expect(bus.hasActiveSubscribers).toBe(false);
});

test("a stalled client is cut off without affecting another observer", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const bus = createSessionEventBus(100_000, 1024 * 1024);
    const slow = createSessionEventResponse(new Request("http://localhost"), bus.subscribe());
    const healthy = createSessionEventResponse(new Request("http://localhost"), bus.subscribe());
    const slowReader = slow.body!.getReader();
    const healthyReader = healthy.body!.getReader();
    const content = "x".repeat(64 * 1024);
    let healthyBytes = 0;
    const drain = (async () => {
      for (;;) {
        const { done, value } = await healthyReader.read();
        if (done) return;
        healthyBytes += value.byteLength;
        if (decoder.decode(value).includes('"end"')) return;
      }
    })();
    // Pace publishing so the healthy consumer drains; the slow one never reads.
    for (let i = 0; i < 200; i++) {
      bus.publish({ type: "delta", content } as SessionEvent);
      if (i % 4 === 0) await Bun.sleep(0);
    }
    bus.publish({ type: "end", reason: "idle" });
    bus.close();
    await drain;
    expect(healthyBytes).toBeGreaterThan(200 * content.length);
    await expect(
      (async () => {
        for (;;) if ((await slowReader.read()).done) return;
      })(),
    ).rejects.toThrow("SSE observation backlog exceeded");
    expect(bus.hasActiveSubscribers).toBe(false);
  } finally {
    error.mockRestore();
  }
});
