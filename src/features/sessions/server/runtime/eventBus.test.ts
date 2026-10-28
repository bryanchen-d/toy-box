import { describe, expect, test } from "bun:test";
import { createSessionEventBus } from "./eventBus";
import type { SessionEvent } from "@sessions/model";

function event(content: string): SessionEvent {
  return { type: "delta", content };
}

function createTestBus(capacity = 10) {
  return createSessionEventBus(capacity);
}

async function nextValue<T>(iterator: AsyncIterator<T>): Promise<T> {
  const result = await iterator.next();
  expect(result.done).toBe(false);
  return result.value!;
}

describe("session event bus replay and live delivery", () => {
  test("stamps dense event ids as events are published", () => {
    const bus = createTestBus();

    const one = bus.publish(event("one"));
    const two = bus.publish(event("two"));

    expect(one).toEqual(expect.objectContaining({ type: "delta", content: "one" }));
    expect(one.eventId).toEqual(expect.any(Number));
    expect(two.eventId).toBe(one.eventId! + 1);
  });

  test("replays retained events after a cursor, then streams live appends", async () => {
    const bus = createTestBus();
    const one = bus.publish(event("one"));
    const two = bus.publish(event("two"));
    const three = bus.publish(event("three"));

    const subscription = bus.subscribe(one.eventId);
    const four = bus.publish(event("four"));

    expect(await nextValue(subscription)).toEqual(two);
    expect(await nextValue(subscription)).toEqual(three);
    expect(await nextValue(subscription)).toEqual(four);

    await subscription.return();
  });

  test("registers active and passive subscribers before the first pull", async () => {
    const bus = createTestBus();
    const passive = bus.subscribe(undefined, "passive");

    expect(bus.hasActiveSubscribers).toBe(false);

    const subscription = bus.subscribe();
    expect(bus.hasActiveSubscribers).toBe(true);

    const live = bus.publish(event("live"));

    expect(await nextValue(subscription)).toEqual(live);

    await subscription.return();
    expect(bus.hasActiveSubscribers).toBe(false);

    await passive.return();
  });

  test("keeps event ids monotonic across buses after a synchronous burst", () => {
    const first = createTestBus(1);
    let last = first.publish(event("0"));
    for (let index = 1; index < 2_000; index++) {
      last = first.publish(event(String(index)));
    }

    const second = createTestBus(1);
    expect(second.publish(event("next")).eventId).toBe(last.eventId! + 1);
  });
});

describe("session event bus retention", () => {
  test("accepts exactly the encoded byte budget, rejects the next event and clears cancelled replay", async () => {
    const sample = createTestBus().publish(event("\u754c\n"));
    const bytes = new TextEncoder().encode(JSON.stringify(sample)).byteLength;
    const bus = createSessionEventBus(10, bytes * 2);
    const slow = bus.subscribe();
    bus.publish(event("\u754c\n"));
    bus.publish(event("\u754c\n"));
    expect(bus.hasActiveSubscribers).toBe(true);
    expect(bus.replaySince()).toHaveLength(2);
    const replay = bus.subscribe();
    await replay.return();
    expect(await replay.next()).toEqual({ done: true, value: undefined });
    bus.publish(event("\u754c\n"));
    expect(bus.replaySince()).toHaveLength(2);
    await expect(slow.next()).rejects.toThrow("backlog");
    await slow.return();
  });

  test("rejects only a stalled observer when its count budget fills", async () => {
    const bus = createTestBus(2);
    const slow = bus.subscribe();
    const fast = bus.subscribe(undefined, "passive");
    for (let index = 0; index < 3; index++) {
      const read = fast.next();
      const published = bus.publish(event(String(index)));
      expect((await read).value).toEqual(published);
    }
    expect(bus.hasActiveSubscribers).toBe(false);
    await expect(slow.next()).rejects.toThrow("backlog");
    await slow.return();
    expect(await slow.next()).toEqual({ done: true, value: undefined });
    await fast.return();
  });

  test("bounds replay and pending bytes using serialized UTF-8, not characters", async () => {
    const bus = createSessionEventBus(10, 180);
    const slow = bus.subscribe();
    const one = bus.publish(event("\u{1f600}".repeat(12)));
    const two = bus.publish(event("\u{1f600}".repeat(12)));
    expect(new TextEncoder().encode(JSON.stringify(one)).byteLength).toBeGreaterThan(90);
    expect(bus.replaySince()).toEqual([two]);
    await expect(slow.next()).rejects.toThrow("backlog");
    const replay = bus.subscribe(one.eventId);
    expect(await nextValue(replay)).toEqual(two);
    await replay.return();
  });

  test("allows one oversized event but no accumulation behind it, including replay", async () => {
    const bus = createSessionEventBus(10, 100);
    const large = bus.publish(event("x".repeat(200)));
    const slow = bus.subscribe();
    expect(bus.replaySince()).toEqual([large]);
    const fast = bus.subscribe();
    expect(await nextValue(fast)).toEqual(large);
    const next = fast.next();
    const small = bus.publish(event("small"));
    expect((await next).value).toEqual(small);
    expect(bus.replaySince()).toEqual([small]);
    await expect(slow.next()).rejects.toThrow("backlog");
    await fast.return();
  });

  test("rejects discarded cursors without assuming adjacent per-session IDs", async () => {
    const bus = createTestBus(1);
    const other = createTestBus();
    const discarded = bus.publish(event("discarded"));
    const validCursor = other.publish(event("other session"));
    const retained = bus.publish(event("retained"));
    expect(() => bus.subscribe(discarded.eventId! - 1)).toThrow("replay");
    const valid = bus.subscribe(validCursor.eventId);
    expect(await nextValue(valid)).toEqual(retained);
    await valid.return();
    bus.clearReplay();
    expect(() => bus.subscribe(discarded.eventId)).toThrow("replay");
  });

  test("caps replay history to the newest events", () => {
    const bus = createTestBus(3);

    bus.publish(event("one"));
    const two = bus.publish(event("two"));
    const three = bus.publish(event("three"));
    const four = bus.publish(event("four"));

    expect(bus.replaySince()).toEqual([two, three, four]);
  });

  test("returns defensive replay copies", () => {
    const bus = createTestBus();
    const one = bus.publish(event("one"));
    const two = bus.publish(event("two"));

    const copy = bus.replaySince();
    copy.length = 0;

    expect(bus.replaySince()).toEqual([one, two]);
  });
});

describe("session event bus lifecycle", () => {
  test("clearReplay drops replay history without closing live subscribers", async () => {
    const bus = createTestBus();
    const subscription = bus.subscribe();

    const old = bus.publish(event("old"));
    bus.clearReplay();
    const live = bus.publish(event("live"));

    expect(bus.replaySince()).toEqual([live]);
    expect(await nextValue(subscription)).toEqual(old);
    expect(await nextValue(subscription)).toEqual(live);

    await subscription.return();
  });

  test("close lets subscribers drain queued events, then completes", async () => {
    const bus = createTestBus();
    const retained = bus.publish(event("retained"));

    const subscription = bus.subscribe();
    const live = bus.publish(event("live"));
    bus.close();

    expect(await nextValue(subscription)).toEqual(retained);
    expect(await nextValue(subscription)).toEqual(live);
    expect(await subscription.next()).toEqual({ done: true, value: undefined });
  });

  test("return releases a pending read and remains idempotent", async () => {
    const bus = createTestBus();
    const subscription = bus.subscribe();
    const pendingRead = subscription.next();

    await subscription.return();
    await subscription.return();
    bus.publish(event("ignored"));

    expect(await pendingRead).toEqual({ done: true, value: undefined });
    expect(await subscription.next()).toEqual({ done: true, value: undefined });
  });
});
