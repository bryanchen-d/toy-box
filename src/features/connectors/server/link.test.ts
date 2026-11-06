import { describe, expect, onTestFinished, test } from "bun:test";
import { createTestDatabase } from "@/server/database";
import {
  CONNECTOR_MESSAGE_TTL_MS,
  CONNECTOR_PROTOCOL_VERSION,
  type ConnectorEvent,
  type ConnectorMessage,
} from "../model";
import { ConnectorDatabase, type ConnectorRecord } from "./database";
import { ConnectorLink, type ConnectorLinkDependencies } from "./link";

const FAST = { min: 10, max: 20 };

/** A connector that speaks the protocol and records what Agent Teams sends it. */
function fakeConnector() {
  const events: { seq: number; data: Record<string, unknown> }[] = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const received: { body: ConnectorMessage; client: string | null }[] = [];
  const acks: number[] = [];
  const directories: unknown[] = [];
  const streamRequests: (string | null)[] = [];
  const responses: number[] = [];
  const encoder = new TextEncoder();
  const frame = ({ seq, data }: (typeof events)[number]) =>
    encoder.encode(`id: ${seq}\nevent: message\ndata: ${JSON.stringify(data)}\n\n`);

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/connector/v1/stream") {
        const after = Number(request.headers.get("last-event-id") ?? 0);
        streamRequests.push(request.headers.get("last-event-id"));
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            controller = stream;
            streams.add(stream);
            stream.enqueue(encoder.encode(": connected\n\n"));
            for (const event of events) if (event.seq > after) stream.enqueue(frame(event));
          },
          cancel() {
            streams.delete(controller);
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (pathname === "/connector/v1/messages") {
        received.push({
          body: (await request.json()) as ConnectorMessage,
          client: request.headers.get("x-connector-client"),
        });
        const status = responses.shift() ?? 202;
        return Response.json(status === 202 ? { version: 1, accepted: true } : { error: "nope" }, {
          status,
        });
      }
      if (pathname === "/connector/v1/ack") {
        acks.push(((await request.json()) as { through: number }).through);
        return new Response(null, { status: 204 });
      }
      if (pathname === "/connector/v1/directory") {
        directories.push(await request.json());
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  onTestFinished(() => server.stop(true));

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    received,
    acks,
    directories,
    streamRequests,
    /** Statuses for the next message deliveries, in order; afterwards 202. */
    respondWith: (...statuses: number[]) => responses.push(...statuses),
    publish(content: string, extra: Partial<ConnectorEvent> = {}) {
      const event = {
        seq: events.length + 1,
        data: {
          version: CONNECTOR_PROTOCOL_VERSION,
          id: `event-${events.length + 1}`,
          conversationId: "conversation-1",
          kind: "message",
          content,
          ...extra,
        },
      };
      events.push(event);
      for (const stream of streams) stream.enqueue(frame(event));
    },
    dropStreams() {
      for (const stream of streams) stream.close();
      streams.clear();
    },
  };
}

async function openLink(
  connector: ReturnType<typeof fakeConnector>,
  overrides: Partial<ConnectorLinkDependencies> = {},
) {
  const db = await createTestDatabase();
  onTestFinished(() => db.close());
  const database = new ConnectorDatabase(db);
  const record = await database.create({
    name: "BryanBot",
    transport: { type: "http", url: connector.baseUrl },
  });
  const applied: ConnectorEvent[] = [];
  const undelivered: { id: string; reason: string }[] = [];
  const start = (current: ConnectorRecord = record) => {
    const link = new ConnectorLink(current, {
      database,
      openEndpoint: async (transport) => ({
        baseUrl: transport.type === "http" ? transport.url : "",
        dispose: () => {},
      }),
      applyEvent: async (_connector, event) => {
        applied.push(event);
      },
      noteUndelivered: async (_connector, message, reason) => {
        undelivered.push({ id: message.id, reason });
      },
      readDirectory: async () => [{ id: "team-1", name: "Docs" }],
      onChange: () => {},
      ...overrides,
      timing: {
        ackDelayMs: 10,
        heartbeatTimeoutMs: 2_000,
        reconnectBackoff: FAST,
        deliveryBackoff: FAST,
        ...overrides.timing,
      },
    });
    link.start();
    onTestFinished(() => link.stop());
    return link;
  };
  return { database, record, applied, undelivered, start };
}

function message(id: string, conversationId = "conversation-1"): ConnectorMessage {
  return {
    version: CONNECTOR_PROTOCOL_VERSION,
    id,
    conversationId,
    sender: { kind: "agent", name: "Lead" },
    origin: { kind: "team", teamId: "team-1", teamName: "Docs" },
    content: `Message ${id}`,
  };
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the link.");
    await Bun.sleep(10);
  }
}

describe("following a connector's stream", () => {
  test("applies events in order, records the cursor, and acknowledges it", async () => {
    const connector = fakeConnector();
    connector.publish("first");
    const { database, record, applied, start } = await openLink(connector);
    const link = start();
    await until(() => link.status.state === "connected");
    connector.publish("second");

    await until(() => connector.acks.at(-1) === 2);
    expect(applied.map(({ content }) => content)).toEqual(["first", "second"]);
    expect((await database.get(record.id))?.receivedThrough).toBe(2);
    expect(connector.directories).toEqual([
      { version: 1, teams: [{ id: "team-1", name: "Docs" }] },
    ]);
  });

  test("resumes after a dropped stream from its cursor, without applying anything twice", async () => {
    const connector = fakeConnector();
    connector.publish("first");
    const { applied, start } = await openLink(connector);
    start();
    await until(() => applied.length === 1);

    connector.dropStreams();
    connector.publish("missed while away");
    await until(() => applied.length === 2);
    expect(connector.streamRequests).toEqual(["0", "1"]);
    expect(applied.map(({ content }) => content)).toEqual(["first", "missed while away"]);
  });

  test("reconnects when the connector stops sending heartbeats", async () => {
    const connector = fakeConnector();
    const errors = new Set<string>();
    let link: ConnectorLink | undefined;
    const { start } = await openLink(connector, {
      timing: { heartbeatTimeoutMs: 100 },
      onChange: () => {
        if (link?.status.state === "connecting" && link.status.error) errors.add(link.status.error);
      },
    });
    link = start();
    await until(() => connector.streamRequests.length >= 2);
    expect([...errors]).toEqual(["The connector stopped sending heartbeats."]);
  });

  test("replays an event whose application failed", async () => {
    const connector = fakeConnector();
    connector.publish("flaky");
    let failures = 1;
    const applied: string[] = [];
    const { database, record, start } = await openLink(connector, {
      applyEvent: async (_connector, event) => {
        if (failures-- > 0) throw new Error("database busy");
        applied.push(event.content);
      },
    });
    start();
    await until(() => applied.length === 1);
    expect(applied).toEqual(["flaky"]);
    expect((await database.get(record.id))?.receivedThrough).toBe(1);
  });

  test("drops events it can't read but keeps following", async () => {
    const connector = fakeConnector();
    connector.publish("bad", { version: 99 } as never);
    connector.publish("good");
    const { database, record, applied, start } = await openLink(connector);
    start();
    await until(() => applied.length === 1);
    expect(applied.map(({ content }) => content)).toEqual(["good"]);
    await until(async () => (await database.get(record.id))?.receivedThrough === 2);
  });
});

describe("delivering to a connector", () => {
  test("posts queued messages once connected and removes them", async () => {
    const connector = fakeConnector();
    const { database, record, start } = await openLink(connector);
    await database.enqueue(record.id, message("m1"));
    await database.enqueue(record.id, message("m2"));
    start();

    await until(() => connector.received.length === 2);
    expect(connector.received.map(({ body }) => body.id)).toEqual(["m1", "m2"]);
    expect(connector.received[0]?.client).toBe(record.clientId);
    await until(async () => (await database.countPending(record.id)) === 0);
  });

  test("retries an unavailable connector and notes a rejected message", async () => {
    const connector = fakeConnector();
    connector.respondWith(503, 400);
    const { database, record, undelivered, start } = await openLink(connector);
    await database.enqueue(record.id, message("retried"));
    await database.enqueue(record.id, message("rejected", "conversation-2"));
    start();

    await until(() => undelivered.length === 1 && connector.received.length >= 3);
    expect(undelivered).toEqual([{ id: "rejected", reason: "rejected" }]);
    expect(connector.received.map(({ body }) => body.id)).toEqual([
      "retried",
      "rejected",
      "retried",
    ]);
    await until(async () => (await database.countPending(record.id)) === 0);
  });

  test("drops and notes messages still undelivered after five days", async () => {
    const connector = fakeConnector();
    const { database, record, undelivered, start } = await openLink(connector);
    const created = new Date(Date.now() - CONNECTOR_MESSAGE_TTL_MS - 1);
    await database.enqueue(record.id, message("stale"), created);
    start();

    await until(() => undelivered.length === 1);
    expect(undelivered).toEqual([{ id: "stale", reason: "expired" }]);
    expect(connector.received).toEqual([]);
  });
});
