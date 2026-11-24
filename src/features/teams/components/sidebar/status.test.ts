import { expect, test } from "bun:test";
import { teamStatus, type Team } from "@teams/model";
import { teamSidebarStatus } from "./status";

const team: Team = {
  id: "team",
  name: "Planning",
  paused: false,
  model: { provider: "copilot", name: "default" },
  latestSequence: 2,
  attentionSequence: 2,
  seenThrough: 1,
  pendingRequests: [],
  completedSequence: null,
  updatedAt: new Date(0).toISOString(),
};

test.each([
  { request: true, done: true, open: false, expected: "waiting" },
  { request: true, done: true, open: true, expected: "waiting" },
  { request: false, done: true, open: false, expected: "finished" },
  { request: false, done: true, open: true, expected: undefined },
  { request: false, done: false, open: false, expected: "unread" },
  { request: false, done: false, open: true, expected: undefined },
])(
  "status priority and visibility: request=$request done=$done open=$open",
  ({ request, done, open, expected }) => {
    const current = {
      ...team,
      pendingRequests: request ? [{ sequence: 2, threadSequence: 1, agentId: "builder" }] : [],
      completedSequence: done ? 2 : null,
    };
    expect(teamSidebarStatus(current, teamStatus(current), open)?.kind).toBe(expected);
  },
);

test("a read team needs no status badge", () => {
  const current = { ...team, seenThrough: team.latestSequence };
  expect(teamSidebarStatus(current, teamStatus(current), false)).toBeUndefined();
});

test("newer messages that don't involve the user leave the team read", () => {
  const current = { ...team, latestSequence: 9, attentionSequence: 1 };
  expect(teamStatus(current)).toBeNull();
});
