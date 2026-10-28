import type { CustomFetch } from "@tanstack/react-start";
import type { SessionEvent, SessionState } from "./model";
import {
  isSessionObservationError,
  SessionObservationError,
  type StreamSessionRequest,
} from "./model/protocol";

/** Wire failures remain identifiable when a Query-owned request has multiple observers. */
export function createSessionFetch(
  onFailure?: (error: SessionObservationError) => void,
  onEnd?: VoidFunction,
): CustomFetch {
  const fail = (cause: unknown) => {
    const error = new SessionObservationError("Session transport failed.", { cause });
    onFailure?.(error);
    return error;
  };
  return async (input, init) => {
    let response: Response;
    try {
      response = await globalThis.fetch(input, init);
    } catch (error) {
      throw fail(error);
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              reader.releaseLock();
              controller.close();
              onEnd?.();
            } else controller.enqueue(next.value);
          } catch (error) {
            reader.releaseLock();
            controller.error(fail(error));
          }
        },
        cancel: async (reason) => {
          await reader.cancel(reason);
          reader.releaseLock();
        },
      }),
      response,
    );
  };
}

/** One observation lifetime, including snapshot-first recovery from transport loss. */
export async function observeSession(
  initialRequest: StreamSessionRequest,
  {
    signal,
    stream,
    refresh,
    adopt,
    apply,
    onError,
  }: {
    signal: AbortSignal;
    stream: (
      request: StreamSessionRequest,
      transport: { signal: AbortSignal; fetch: CustomFetch },
    ) => Promise<AsyncIterable<SessionEvent> | undefined>;
    refresh: () => Promise<SessionState>;
    adopt: (snapshot: SessionState) => void;
    apply: (event: SessionEvent) => void;
    onError: (error: unknown) => void;
  },
): Promise<boolean> {
  let request = initialRequest;
  let needsSnapshot = false;
  while (!signal.aborted) {
    const attempt = new AbortController();
    const transportSignal = AbortSignal.any([signal, attempt.signal]);
    let eofTimer: ReturnType<typeof setTimeout> | undefined;
    let transportLost = false;
    let completed = false;
    let failTransport!: (error: unknown) => void;
    const transportFailure = new Promise<never>((_, reject) => {
      failTransport = (error) => {
        transportLost = true;
        reject(error);
      };
    });
    const onAbort = () => failTransport(transportSignal.reason);
    transportSignal.addEventListener("abort", onAbort, { once: true });
    const stopped = () => transportSignal.aborted || transportLost;
    const rejectStream = (error: unknown): never => {
      if (isSessionObservationError(error)) transportLost = true;
      throw error;
    };
    // TanStack's framed decoder logs body errors but can leave deserialized
    // iterator promises pending. Observe the wire without replacing its codec.
    const observedFetch = createSessionFetch(failTransport, () => {
      // Allow already-delivered patches to finish normal iteration.
      if (!completed && !attempt.signal.aborted) {
        eofTimer = setTimeout(
          () =>
            failTransport(
              new SessionObservationError("Session transport ended before observation completed."),
            ),
          1_000,
        );
      }
    });
    const transport = { signal: transportSignal, fetch: observedFetch };
    const consume = async () => {
      if (needsSnapshot) {
        const snapshot = await refresh().catch(rejectStream);
        if (stopped()) return false;
        adopt(snapshot);
        // The first request may have reached the server. Never submit it twice.
        request = {
          sessionId: initialRequest.sessionId,
          mode: "mode" in initialRequest ? initialRequest.mode : undefined,
          afterEventId: snapshot.lastSeenEventId,
        };
        needsSnapshot = false;
      }
      if (stopped()) return false;
      let events: AsyncIterable<SessionEvent> | undefined;
      try {
        events = await stream(request, transport);
      } catch (error) {
        rejectStream(error);
      }
      if (stopped()) return false;
      let receivedEvent = false;
      if (events) {
        let iterator: AsyncIterator<SessionEvent>;
        try {
          iterator = events[Symbol.asyncIterator]();
        } catch (error) {
          return rejectStream(error);
        }
        try {
          while (!stopped()) {
            let next: IteratorResult<SessionEvent>;
            try {
              next = await iterator.next();
            } catch (error) {
              return rejectStream(error);
            }
            if (stopped() || next.done) break;
            apply(next.value);
            receivedEvent = true;
          }
        } finally {
          // A lost wire can strand next(); return() would queue behind it.
          if (!stopped()) await iterator.return?.();
        }
      }
      return receivedEvent;
    };
    try {
      const receivedEvent = await Promise.race([consume(), transportFailure]);
      completed = !signal.aborted;
      return receivedEvent;
    } catch (error) {
      if (signal.aborted) return false;
      if (!transportLost) throw error;
      onError(error);
      needsSnapshot = true;
    } finally {
      transportSignal.removeEventListener("abort", onAbort);
      if (!completed) attempt.abort();
      clearTimeout(eofTimer);
    }
    await waitToRetry(signal);
  }
  return false;
}

function waitToRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    signal.addEventListener("abort", finish, { once: true });
  });
}
