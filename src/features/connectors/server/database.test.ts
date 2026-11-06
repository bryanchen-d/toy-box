import { describe, expect, onTestFinished, test } from "bun:test";
import { createTestDatabase } from "@/server/database";
import { CONNECTOR_PROTOCOL_VERSION, type ConnectorMessage } from "../model";
import { ConnectorDatabase, ConnectorNameTakenError } from "./database";

const options = {
  name: "BryanBot",
  transport: { type: "http" as const, url: "http://127.0.0.1:4243" },
};

async function openConnectors() {
  const db = await createTestDatabase();
  onTestFinished(() => db.close());
  return new ConnectorDatabase(db);
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

describe("connector records", () => {
  test("create a client identity and an empty cursor, and update in place", async () => {
    const connectors = await openConnectors();
    const created = await connectors.create(options);
    expect(created).toMatchObject({ ...options, receivedThrough: 0 });
    expect(created.clientId).toMatch(/^[0-9a-f-]{36}$/);

    const updated = await connectors.update(created.id, {
      name: "Bryan Bot",
      transport: { type: "devtunnel", tunnelId: "bryanbot.usw2", port: 4243 },
    });
    expect(updated).toMatchObject({
      id: created.id,
      clientId: created.clientId,
      name: "Bryan Bot",
      transport: { type: "devtunnel", tunnelId: "bryanbot.usw2", port: 4243 },
    });
    expect(await connectors.list()).toEqual([updated!]);
  });

  test("two connectors can't share a mention handle", async () => {
    const connectors = await openConnectors();
    await connectors.create(options);
    expect(connectors.create({ ...options, name: "bryanbot" })).rejects.toBeInstanceOf(
      ConnectorNameTakenError,
    );
    const other = await connectors.create({ ...options, name: "Watcher" });
    expect(connectors.update(other.id, { ...options, name: "BRYANBOT" })).rejects.toBeInstanceOf(
      ConnectorNameTakenError,
    );
  });

  test("the received cursor only moves forward", async () => {
    const connectors = await openConnectors();
    const { id } = await connectors.create(options);
    await connectors.advanceReceivedThrough(id, 7);
    await connectors.advanceReceivedThrough(id, 3);
    expect((await connectors.get(id))?.receivedThrough).toBe(7);
  });

  test("deleting a connector drops its queued messages", async () => {
    const connectors = await openConnectors();
    const { id } = await connectors.create(options);
    await connectors.enqueue(id, message("m1"));
    expect(await connectors.delete(id)).toBe(true);
    expect(await connectors.countPending(id)).toBe(0);
  });
});

describe("connector outbox", () => {
  test("queues each message once", async () => {
    const connectors = await openConnectors();
    const { id } = await connectors.create(options);
    await connectors.enqueue(id, message("m1"));
    await connectors.enqueue(id, message("m1"));
    expect(await connectors.countPending(id)).toBe(1);
  });

  test("offers only the head of each conversation, so a retry never reorders it", async () => {
    const connectors = await openConnectors();
    const { id } = await connectors.create(options);
    const now = new Date("2026-11-05T00:00:00.000Z");
    await connectors.enqueue(id, message("a1", "a"), now);
    await connectors.enqueue(id, message("b1", "b"), now);
    await connectors.enqueue(id, message("a2", "a"), now);
    expect((await connectors.dueMessages(id, now)).map(({ id }) => id)).toEqual(["a1", "b1"]);

    // The head backs off; the message behind it waits rather than overtaking it.
    const later = new Date(now.getTime() + 5_000);
    await connectors.recordFailure(id, "a1", "HTTP 503", later);
    expect((await connectors.dueMessages(id, now)).map(({ id }) => id)).toEqual(["b1"]);
    expect(await connectors.nextAttemptAt(id)).toBe(now.toISOString());

    // Once only the waiting conversation remains, nothing is due until its head is.
    await connectors.remove(id, "b1");
    expect(await connectors.dueMessages(id, now)).toEqual([]);
    expect(await connectors.nextAttemptAt(id)).toBe(later.toISOString());
    expect(await connectors.dueMessages(id, later)).toMatchObject([{ id: "a1", attempts: 1 }]);
  });

  test("takes expired messages oldest first", async () => {
    const connectors = await openConnectors();
    const { id } = await connectors.create(options);
    await connectors.enqueue(id, message("old"), new Date("2026-11-01T00:00:00.000Z"));
    await connectors.enqueue(id, message("older"), new Date("2026-10-31T00:00:00.000Z"));
    await connectors.enqueue(id, message("new"), new Date("2026-11-05T00:00:00.000Z"));
    const expired = await connectors.takeExpired(id, new Date("2026-11-02T00:00:00.000Z"));
    expect(expired.map(({ id }) => id)).toEqual(["older", "old"]);
    expect(expired[0]?.message).toEqual(message("older"));
    expect(await connectors.countPending(id)).toBe(1);
  });
});
