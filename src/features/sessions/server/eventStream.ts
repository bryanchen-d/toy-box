// Raw wire for live Session events. TanStack's framed serializer would retain
// every streamed event object in a lifetime reference graph, so the server
// function returns a standard SSE Response, which the framework passes through
// untouched (x-tss-raw). Event identity is not part of the protocol.

import type { SessionEvent } from "@sessions/model";
import { createSseResponse } from "@/shared/server/sse";
import type { SessionStreamSubscription } from "./runtime/eventBus";

/** No live stream exists: the client stays idle without observing anything. */
export function createNoLiveSessionResponse(): Response {
  return new Response(null, { status: 204 });
}

/** Forward one subscription as SSE frames until its stream ends or the client leaves.
 *  Closing the response, for any reason, releases the subscriber but never the Session. */
export function createSessionEventResponse(
  request: Request,
  subscription: SessionStreamSubscription,
): Response {
  if (request.signal.aborted) void subscription.return();
  return createSseResponse<SessionEvent>(request, (send, close) => {
    void (async () => {
      try {
        for (;;) {
          const next = await subscription.next();
          if (next.done) break;
          send(next.value);
          if (next.value.type === "end") break;
        }
      } catch (error) {
        console.error("Session observation stopped:", error);
      } finally {
        close();
      }
    })();
    return () => void subscription.return();
  });
}
