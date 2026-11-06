import { describe, expect, test } from "bun:test";
import {
  backoffDelay,
  connectorEventSchema,
  connectorHandle,
  connectorOptionsSchema,
  connectorsAddressedBy,
  DELIVERY_BACKOFF,
} from ".";

describe("connector options", () => {
  test("accept an HTTP URL or a dev tunnel and port", () => {
    expect(
      connectorOptionsSchema.parse({
        name: " BryanBot ",
        transport: { type: "http", url: "http://127.0.0.1:4243" },
      }),
    ).toEqual({ name: "BryanBot", transport: { type: "http", url: "http://127.0.0.1:4243" } });
    expect(
      connectorOptionsSchema.safeParse({
        name: "BryanBot",
        transport: { type: "devtunnel", tunnelId: "bryanbot.usw2", port: 4243 },
      }).success,
    ).toBe(true);
  });

  test("reject URLs that aren't HTTP and ports out of range", () => {
    for (const transport of [
      { type: "http", url: "file:///etc/passwd" },
      { type: "http", url: "not a url" },
      { type: "devtunnel", tunnelId: "bryanbot", port: 0 },
      { type: "devtunnel", tunnelId: "bryanbot", port: 70_000 },
    ]) {
      expect(connectorOptionsSchema.safeParse({ name: "BryanBot", transport }).success).toBe(false);
    }
  });
});

describe("connector addressing", () => {
  const connectors = [{ name: "BryanBot" }, { name: "Build Watcher" }];

  test("a message addresses the connectors it opens with", () => {
    expect(connectorHandle({ name: "Build Watcher" })).toBe("build-watcher");
    expect(connectorsAddressedBy("@bryanbot post this to #dev", connectors)).toEqual([
      { name: "BryanBot" },
    ]);
    expect(connectorsAddressedBy("@build-watcher, @BryanBot: ping", connectors)).toEqual(
      connectors,
    );
    expect(connectorsAddressedBy("@lead @bryanbot post this", connectors)).toEqual([
      { name: "BryanBot" },
    ]);
  });

  test("a connector's handle later in the text is only its name", () => {
    expect(connectorsAddressedBy("This one went through @bryanbot.", connectors)).toEqual([]);
    expect(connectorsAddressedBy("@lead ask @bryanbot to DM me", connectors)).toEqual([]);
  });

  test("never match text that only looks like a mention", () => {
    expect(connectorsAddressedBy("mail bryan@bryanbot.dev", connectors)).toEqual([]);
    expect(connectorsAddressedBy("@bryanbot.dev is down", connectors)).toEqual([]);
    expect(connectorsAddressedBy("@everyone look", connectors)).toEqual([]);
  });
});

describe("connector events", () => {
  const event = {
    version: 1 as const,
    id: "event-1",
    conversationId: "conversation-1",
    content: "Posted to #dev.",
  };

  test("carry Slack provenance and ignore fields this version doesn't use", () => {
    expect(
      connectorEventSchema.parse({
        ...event,
        kind: "reply",
        origin: {
          kind: "slack",
          permalink: "https://example.slack.com/archives/C1/p1",
          requester: { id: "U1", name: "alex", isOwner: false },
          future: true,
        },
        to: { teamId: "team-1" },
        createdAt: "2026-11-05T00:00:00.000Z",
      }),
    ).toEqual({
      ...event,
      origin: {
        kind: "slack",
        permalink: "https://example.slack.com/archives/C1/p1",
        requester: { id: "U1", name: "alex", isOwner: false },
      },
      to: { teamId: "team-1" },
    });
  });

  test("reject another protocol version and empty content", () => {
    expect(connectorEventSchema.safeParse({ ...event, version: 2 }).success).toBe(false);
    expect(connectorEventSchema.safeParse({ ...event, content: "  " }).success).toBe(false);
  });
});

describe("delivery timing", () => {
  test("backs off exponentially within its bounds", () => {
    const middle = () => 0.5;
    expect(backoffDelay(1, DELIVERY_BACKOFF, middle)).toBe(5_000);
    expect(backoffDelay(2, DELIVERY_BACKOFF, middle)).toBe(10_000);
    expect(backoffDelay(20, DELIVERY_BACKOFF, middle)).toBe(300_000);
  });

  test("jitters by up to a fifth either way", () => {
    expect(backoffDelay(1, DELIVERY_BACKOFF, () => 0)).toBe(4_000);
    expect(backoffDelay(1, DELIVERY_BACKOFF, () => 1)).toBe(6_000);
  });
});
