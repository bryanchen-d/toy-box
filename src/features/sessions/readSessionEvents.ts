// Client side of the raw Session event wire (see server/eventStream.ts).

import { EventSourceParserStream } from "eventsource-parser/stream";
import type { SessionEvent } from "./model";
import { isSessionObservationError, SessionObservationError } from "./model/protocol";

/** Events from a raw stream response, or undefined when no live stream exists.
 *  The canonical `end` event completes it; any other close is observation loss. */
export function readSessionEvents(response: Response): AsyncIterable<SessionEvent> | undefined {
  if (response.status === 204) {
    void response.body?.cancel();
    return undefined;
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel();
    throw new SessionObservationError(`unexpected response (HTTP ${response.status})`);
  }
  return readFrames(response.body);
}

async function* readFrames(body: NonNullable<Response["body"]>): AsyncGenerator<SessionEvent> {
  const reader = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();
  try {
    for (;;) {
      let frame;
      try {
        frame = await reader.read();
      } catch (cause) {
        throw isSessionObservationError(cause)
          ? cause
          : new SessionObservationError("stream failed", { cause });
      }
      if (frame.done) throw new SessionObservationError("stream ended before the session ended");

      let event: SessionEvent;
      try {
        event = JSON.parse(frame.value.data) as SessionEvent;
      } catch (cause) {
        throw new SessionObservationError("malformed event", { cause });
      }
      yield event;
      if (event.type === "end") return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
