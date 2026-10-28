// Per-session event bus: bounded replay plus live fan-out for canonical
// SessionEvents. Subscribing registers immediately, before the caller starts
// pulling, so producers can publish synchronously without losing the first
// event. SessionStream owns the policy that distinguishes active from passive
// subscriptions.
//
// Replay and each observer's backlog have count and UTF-8 JSON byte budgets.
// One oversized event may stand alone; it cannot accumulate a backlog behind it.
//
// This is an explicit iterator rather than an async generator because generator
// return() waits behind an outstanding next(). A subscription must instead
// release its subscriber immediately when the request disconnects.

import type { SessionEvent } from "@sessions/model";
import { SessionObservationError, type SessionSubscriptionMode } from "@sessions/model/protocol";

export type SessionStreamSubscription = AsyncIterableIterator<SessionEvent> & {
  return(value?: unknown): Promise<IteratorResult<SessionEvent>>;
};

type SessionEventBus = {
  publish(event: SessionEvent): SessionEvent;
  subscribe(afterEventId?: number, mode?: SessionSubscriptionMode): SessionStreamSubscription;
  replaySince(afterEventId?: number): SessionEvent[];
  clearReplay(): void;
  close(): void;
  readonly hasActiveSubscribers: boolean;
};

type StampedSessionEvent = SessionEvent & { eventId: number };
type BufferedEvent = { event: StampedSessionEvent; bytes: number };
type PendingRead = (event: SessionEvent | undefined) => void;

type SessionSubscriber = {
  pendingEvents: BufferedEvent[];
  pendingBytes: number;
  disconnected: boolean;
  mode: SessionSubscriptionMode;
  resumePendingRead?: PendingRead;
  error?: Error;
};

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

// Last event id issued in this process. The first event uses a Date.now seed;
// every later event increments that seed densely. A burst faster than 1
// event/ms therefore cannot hand a replacement stream a lower id, which would
// make the client's lastSeenEventId filter silently drop the next turn.
let lastIssuedEventId = 0;

function nextEventId(): number {
  lastIssuedEventId = lastIssuedEventId === 0 ? Date.now() : lastIssuedEventId + 1;
  return lastIssuedEventId;
}

export function createSessionEventBus(
  capacity: number,
  maxBytes = MAX_BUFFER_BYTES,
): SessionEventBus {
  const history: BufferedEvent[] = [];
  const subscribers = new Set<SessionSubscriber>();
  let historyBytes = 0;
  let lastDiscardedEventId: number | undefined;
  let closed = false;

  function replaySince(afterEventId?: number): SessionEvent[] {
    if (
      afterEventId !== undefined &&
      lastDiscardedEventId !== undefined &&
      afterEventId < lastDiscardedEventId
    ) {
      throw new SessionObservationError(
        "Session replay expired; recover from an authoritative snapshot.",
      );
    }
    return history
      .filter(({ event }) => afterEventId === undefined || event.eventId > afterEventId)
      .map(({ event }) => event);
  }

  function publishToSubscriber(subscriber: SessionSubscriber, buffered: BufferedEvent): void {
    if (subscriber.resumePendingRead) {
      const resumePendingRead = subscriber.resumePendingRead;
      subscriber.resumePendingRead = undefined;
      resumePendingRead(buffered.event);
      return;
    }

    if (
      subscriber.pendingEvents.length > 0 &&
      (subscriber.pendingEvents.length >= capacity ||
        subscriber.pendingBytes + buffered.bytes > maxBytes)
    ) {
      disconnectSubscriber(
        subscriber,
        true,
        new SessionObservationError(
          "Session observation backlog exceeded; recover from an authoritative snapshot.",
        ),
      );
      return;
    }
    subscriber.pendingEvents.push(buffered);
    subscriber.pendingBytes += buffered.bytes;
  }

  function disconnectSubscriber(
    subscriber: SessionSubscriber,
    discard = false,
    error?: Error,
  ): void {
    subscriber.disconnected = true;
    subscribers.delete(subscriber);
    if (discard) {
      subscriber.pendingEvents.length = 0;
      subscriber.pendingBytes = 0;
      subscriber.error = error;
    }
    if (subscriber.resumePendingRead && subscriber.pendingEvents.length === 0) {
      const resumePendingRead = subscriber.resumePendingRead;
      subscriber.resumePendingRead = undefined;
      resumePendingRead(undefined);
    }
  }

  function readNextEvent(subscriber: SessionSubscriber): Promise<SessionEvent | undefined> {
    if (subscriber.error) return Promise.reject(subscriber.error);
    if (subscriber.pendingEvents.length > 0) {
      const buffered = subscriber.pendingEvents.shift()!;
      subscriber.pendingBytes -= buffered.bytes;
      return Promise.resolve(buffered.event);
    }

    if (subscriber.disconnected) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      subscriber.resumePendingRead = resolve;
    });
  }

  function createSubscription(subscriber: SessionSubscriber): SessionStreamSubscription {
    let finished = false;

    function finish(): IteratorResult<SessionEvent> {
      finished = true;
      disconnectSubscriber(subscriber, true);
      return { done: true, value: undefined };
    }

    return {
      [Symbol.asyncIterator]() {
        return this;
      },

      async next() {
        if (finished) return { done: true, value: undefined };

        const event = await readNextEvent(subscriber);
        return event === undefined ? finish() : { done: false, value: event };
      },

      async return() {
        // Immediately release the subscriber and resolve any pending next().
        return finish();
      },
    };
  }

  return {
    publish(event) {
      const published: StampedSessionEvent = { ...event, eventId: nextEventId() };
      if (closed) return published;

      const buffered = {
        event: published,
        bytes: encoder.encode(JSON.stringify(published)).byteLength,
      };
      history.push(buffered);
      historyBytes += buffered.bytes;
      while (history.length > 1 && (history.length > capacity || historyBytes > maxBytes)) {
        const discarded = history.shift()!;
        historyBytes -= discarded.bytes;
        lastDiscardedEventId = discarded.event.eventId;
      }

      for (const subscriber of subscribers) {
        publishToSubscriber(subscriber, buffered);
      }

      return published;
    },

    subscribe(afterEventId, mode = "active") {
      replaySince(afterEventId);
      const pendingEvents = history.filter(
        ({ event }) => afterEventId === undefined || event.eventId > afterEventId,
      );
      const subscriber: SessionSubscriber = {
        pendingEvents,
        pendingBytes: pendingEvents.reduce((bytes, buffered) => bytes + buffered.bytes, 0),
        disconnected: closed,
        mode,
      };

      if (!closed) {
        subscribers.add(subscriber);
      }

      return createSubscription(subscriber);
    },

    replaySince,

    clearReplay() {
      // Existing subscribers keep their pending events; only future replay is cleared.
      lastDiscardedEventId = history.at(-1)?.event.eventId ?? lastDiscardedEventId;
      history.length = 0;
      historyBytes = 0;
    },

    close() {
      if (closed) return;
      closed = true;

      for (const subscriber of subscribers) {
        disconnectSubscriber(subscriber);
      }
    },

    get hasActiveSubscribers() {
      for (const subscriber of subscribers) {
        if (subscriber.mode === "active") return true;
      }
      return false;
    },
  };
}
