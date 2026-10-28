import { expect, test } from "bun:test";
import type { SessionEvent } from "./model";
import { isSessionObservationError } from "./model/protocol";
import { readSessionEvents } from "./readSessionEvents";
import { createNoLiveSessionResponse, createSessionEventResponse } from "./server/eventStream";
import { createSessionEventBus } from "./server/runtime/eventBus";

const encoder = new TextEncoder();

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const received: SessionEvent[] = [];
  for await (const event of events) received.push(event);
  return received;
}

function bodyOf(chunks: Uint8Array[], then: "close" | "error" = "close") {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else if (then === "close") controller.close();
      else controller.error(new Error("wire lost"));
    },
  });
}

test("events round-trip through the raw wire, including Unicode split across chunks", async () => {
  const bus = createSessionEventBus(100);
  const events: SessionEvent[] = [
    { type: "delta", content: "caf\u00e9 \u{1f600}\nsecond line\r\nthird" },
    {
      type: "tool_end",
      toolCallId: "call-1",
      success: true,
      result: JSON.stringify({ nested: { list: [1, "\u2028", null] } }),
      attachments: [{ mimeType: "image/png", base64: "AAEC/w==" }],
    },
    { type: "end", reason: "idle" },
  ];
  const subscription = bus.subscribe();
  const published = events.map((event) => bus.publish(event));
  const response = createSessionEventResponse(new Request("http://localhost"), subscription);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  // Re-chunk byte-by-byte so multibyte characters straddle reads.
  const bytes = new Uint8Array(await response.arrayBuffer());
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  const received = await collect(readSessionEvents(new Response(bodyOf(chunks)))!);
  expect(received).toEqual(published);
});

test("a no-live-stream response is idle, not observation loss", async () => {
  const response = createNoLiveSessionResponse();
  expect(response.status).toBe(204);
  expect(readSessionEvents(response)).toBeUndefined();
});

test.each(["close", "error"] as const)(
  "a stream that %ss before the terminal event is observation loss",
  async (then) => {
    const frame = encoder.encode(`data: ${JSON.stringify({ type: "delta", content: "a" })}\n\n`);
    const received: SessionEvent[] = [];
    const failure = await (async () => {
      for await (const event of readSessionEvents(new Response(bodyOf([frame], then)))!) {
        received.push(event);
      }
    })().catch((error: unknown) => error);
    expect(received).toEqual([{ type: "delta", content: "a" }]);
    expect(isSessionObservationError(failure)).toBe(true);
  },
);

test("a truncated frame is never delivered", async () => {
  const partial = encoder.encode('data: {"type":"delta","content":"cut');
  const failure = await collect(readSessionEvents(new Response(bodyOf([partial])))!).catch(
    (error: unknown) => error,
  );
  expect(isSessionObservationError(failure)).toBe(true);
});

test("the terminal event completes the stream and cancels its body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "end", reason: "idle" })}\n\n`),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  expect(await collect(readSessionEvents(new Response(body))!)).toEqual([
    { type: "end", reason: "idle" },
  ]);
  expect(cancelled).toBe(true);
});
