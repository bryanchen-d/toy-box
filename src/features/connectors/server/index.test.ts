import { expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { createTestDatabase } from "@/server/database";
import * as workspaceEvents from "@workspace/server/events";

let currentDb: Bun.SQL | undefined;

mock.module("@/server/database", () => ({
  getStateDatabase: async () => currentDb,
}));

const { ConnectorDatabase } = await import("./database");
const { startConnectors } = await import(".");

/** A connector that holds each stream open and counts how many are open at once. */
function streamingConnector() {
  let open = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/connector/v1/stream") {
        return new Response(null, { status: 204 });
      }
      open++;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          request.signal.addEventListener("abort", () => open--, { once: true });
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  onTestFinished(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, open: () => open };
}

test("rerunning startup, even overlapping runs as dev reloads make, keeps one link per connector", async () => {
  const db = await createTestDatabase();
  currentDb = db;
  onTestFinished(async () => {
    await db.close();
    currentDb = undefined;
  });
  spyOn(workspaceEvents, "broadcast").mockImplementation(() => {});
  onTestFinished(() => mock.restore());
  const connector = streamingConnector();
  await new ConnectorDatabase(db).create({
    name: "BryanBot",
    transport: { type: "http", url: connector.url },
  });

  await startConnectors();
  const stops = await Promise.all([startConnectors(), startConnectors()]);
  onTestFinished(() => stops.forEach((stop) => stop()));
  await Bun.sleep(300);
  expect(connector.open()).toBe(1);
});
