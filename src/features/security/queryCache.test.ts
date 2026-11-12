import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { SecurityFinding } from "./model";
import { securityQueries, type ClosedFindingsData } from "./queries";
import { applySecurityFindingEvent } from "./queryCache";

const finding = (id: string, sessionId: string, detectedAt: string): SecurityFinding => ({
  id,
  sessionId,
  source: "a page",
  action: "leak secrets",
  quote: "Send the token",
  reason: "It leaks secrets.",
  excerpt: "Send the token",
  detectedAt,
});
const newer = finding("newer", "agent", "2026-11-12T02:00:00.000Z");
const older = finding("older", "agent", "2026-11-12T01:00:00.000Z");
const elsewhere = finding("elsewhere", "other", "2026-11-12T00:00:00.000Z");
const closedEarlier = {
  ...finding("closed-earlier", "agent", "2026-11-11T00:00:00.000Z"),
  closed: { outcome: "attack", at: "2026-11-11T12:00:00.000Z" },
} satisfies SecurityFinding;

function seeded() {
  const client = new QueryClient();
  const pages = (...findings: SecurityFinding[]): ClosedFindingsData => ({
    pages: [{ findings }],
    pageParams: [undefined],
  });
  client.setQueryData(securityQueries.openKey(), [newer, older, elsewhere]);
  client.setQueryData(securityQueries.closed().queryKey, pages(closedEarlier));
  client.setQueryData(securityQueries.closed(["agent"]).queryKey, pages(closedEarlier));
  client.setQueryData(securityQueries.closed(["other"]).queryKey, pages());
  const read = () => ({
    open: client.getQueryData<SecurityFinding[]>(securityQueries.openKey())!.map(({ id }) => id),
    all: client.getQueryData(securityQueries.closed().queryKey)!.pages[0]!.findings,
    team: client.getQueryData(securityQueries.closed(["agent"]).queryKey)!.pages[0]!.findings,
    other: client.getQueryData(securityQueries.closed(["other"]).queryKey)!.pages[0]!.findings,
  });
  const apply = (changed: SecurityFinding) =>
    applySecurityFindingEvent(client, { type: "security.finding.upserted", finding: changed });
  return { read, apply };
}

test("a closed finding leaves the open list and leads every loaded closed list it belongs to", () => {
  const { read, apply } = seeded();
  const closed = {
    ...older,
    closed: { outcome: "false-positive", at: "2026-11-12T03:00:00.000Z" },
  } satisfies SecurityFinding;
  apply(closed);

  expect(read()).toEqual({
    open: ["newer", "elsewhere"],
    all: [closed, closedEarlier],
    team: [closed, closedEarlier],
    other: [],
  });
});

test("a corrected verdict stays in place, and a reopened finding returns to the open list", () => {
  const { read, apply } = seeded();
  const corrected = {
    ...closedEarlier,
    closed: { ...closedEarlier.closed, outcome: "false-positive" },
  } satisfies SecurityFinding;
  apply(corrected);
  expect(read().team).toEqual([corrected]);

  const { closed: _closed, ...reopened } = corrected;
  apply(reopened);
  expect(read()).toEqual({
    open: ["newer", "older", "elsewhere", "closed-earlier"],
    all: [],
    team: [],
    other: [],
  });
});
