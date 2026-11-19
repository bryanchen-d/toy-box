import { expect, test } from "bun:test";
import { summarizeConnectorUse, type ConnectorExchange } from "./connectorUse";

const now = new Date("2026-11-18T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60_000).toISOString();
const exchange = (
  kind: ConnectorExchange["kind"],
  teamId: string,
  threadSequence: number | undefined,
  hours: number,
): ConnectorExchange => ({
  kind,
  teamId,
  ...(threadSequence === undefined ? {} : { threadSequence }),
  at: hoursAgo(hours),
});

test("counts what passed each way in the last day and week, by thread and by team", () => {
  const use = summarizeConnectorUse(
    {
      threads: [
        { teamId: "build", threadSequence: 10, openedBy: "connector", excerpt: "CI build failed" },
        { teamId: "build", threadSequence: 20, openedBy: "team", excerpt: "@bryanbot post it" },
        { teamId: "docs", threadSequence: 3, openedBy: "team", excerpt: "@bryanbot DM me" },
        { teamId: "docs", threadSequence: 1, openedBy: "connector", excerpt: "Older than a week" },
      ],
      exchanges: [
        exchange("received", "build", 10, 30),
        exchange("received", "build", 10, 2),
        exchange("sent", "build", 10, 1),
        exchange("sent", "build", 20, 50),
        exchange("undelivered", "build", 20, 49),
        exchange("sent", "docs", 3, 5),
        exchange("undelivered", "docs", undefined, 3),
        exchange("received", "docs", 1, 24 * 8),
      ],
    },
    now,
  );

  expect(use.day).toEqual({ sent: 2, received: 1, undelivered: 1 });
  expect(use.week).toEqual({ sent: 3, received: 2, undelivered: 2 });
  expect(use.threads).toEqual([
    {
      teamId: "build",
      threadSequence: 10,
      openedBy: "connector",
      excerpt: "CI build failed",
      sent: 1,
      received: 2,
      undelivered: 0,
      lastAt: hoursAgo(1),
    },
    {
      teamId: "docs",
      threadSequence: 3,
      openedBy: "team",
      excerpt: "@bryanbot DM me",
      sent: 1,
      received: 0,
      undelivered: 0,
      lastAt: hoursAgo(5),
    },
    {
      teamId: "build",
      threadSequence: 20,
      openedBy: "team",
      excerpt: "@bryanbot post it",
      sent: 1,
      received: 0,
      undelivered: 1,
      lastAt: hoursAgo(49),
    },
  ]);
  expect(use.byTeam).toEqual([
    { teamId: "build", sent: 2, received: 2, undelivered: 1 },
    { teamId: "docs", sent: 1, received: 0, undelivered: 1 },
  ]);
});
