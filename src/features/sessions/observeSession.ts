import type { CustomFetch } from "@tanstack/react-start";
import type { SessionEvent, SessionState } from "./model";
import {
  isSessionObservationError,
  SessionObservationError,
  type StreamSessionRequest,
} from "./model/protocol";

/** Wire failures remain identifiable when a Query-owned request has multiple observers. */
export const sessionFetch = createSessionFetch();

function createSessionFetch(): CustomFetch {
  const fail = (cause: unknown) =>
    new SessionObservationError("Session transport failed.", { cause });
  return async (input, init) => {
    let response: Response;
    try {
      response = await globalThis.fetch(input, init);
    } catch (error) {
      throw fail(error);
    }
    if (response.status === 204 || !response.body) return response;
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              reader.releaseLock();
              controller.close();
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
    const transport = {
      signal: AbortSignal.any([signal, attempt.signal]),
      fetch: sessionFetch,
    };
    const consume = async () => {
      if (needsSnapshot) {
        // The Query owns this shared read; this observer only stops waiting.
        const snapshot = await untilAborted(refresh(), signal);
        if (signal.aborted) return false;
        adopt(snapshot);
        // The first request may have reached the server. Never submit it twice.
        request = {
          sessionId: initialRequest.sessionId,
          mode: "mode" in initialRequest ? initialRequest.mode : undefined,
          afterEventId: snapshot.lastSeenEventId,
        };
        needsSnapshot = false;
      }
      const events = await stream(request, transport);
      if (!events || signal.aborted) return false;

      let receivedEvent = false;
      const iterator = events[Symbol.asyncIterator]();
      try {
        while (!signal.aborted) {
          const next = await iterator.next();
          if (signal.aborted || next.done) break;
          apply(next.value);
          receivedEvent = true;
        }
      } finally {
        await iterator.return?.();
      }
      return receivedEvent;
    };
    try {
      return await consume();
    } catch (error) {
      if (signal.aborted) return false;
      if (!isSessionObservationError(error)) throw error;
      onError(error);
      needsSnapshot = true;
    } finally {
      attempt.abort();
    }
    await waitToRetry(signal);
  }
  return false;
}

/** Wait for a shared read without owning its cancellation; abort leaves it to its Query. */
function untilAborted<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void read.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
