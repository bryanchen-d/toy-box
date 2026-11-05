import { expect, onTestFinished, test } from "bun:test";
import type { TeamEvent } from "@teams/model";
import {
  publishTeamEvent,
  releaseTeamEvents,
  replayTeamEvents,
  subscribeTeamEvents,
} from "./events";

function update(revision: number): TeamEvent {
  return {
    type: "status",
    revision,
    agentId: `session-${revision}`,
    status: { state: "working", text: `Task ${revision}` },
  };
}

test("Team events provide live delivery or a complete revision replay", () => {
  const teamId = `team-${crypto.randomUUID()}`;
  onTestFinished(() => releaseTeamEvents(teamId));
  const received: TeamEvent[] = [];
  const unsubscribe = subscribeTeamEvents(teamId, (event) => received.push(event));
  onTestFinished(unsubscribe);

  const first = update(1);
  const second = update(2);
  publishTeamEvent(teamId, first);
  publishTeamEvent(teamId, second);

  expect(received).toEqual([first, second]);
  expect(replayTeamEvents(teamId, 1, 2)).toEqual([second]);
  expect(replayTeamEvents(teamId, 0, 3)).toBeUndefined();
});

test("the shared replay ring orders and deduplicates publications without hiding gaps", () => {
  const teamId = crypto.randomUUID();
  onTestFinished(() => releaseTeamEvents(teamId));
  const first = update(1);
  const second = update(2);
  publishTeamEvent(teamId, second);
  publishTeamEvent(teamId, second);
  expect(replayTeamEvents(teamId, 0, 2)).toBeUndefined();
  publishTeamEvent(teamId, first);
  expect(replayTeamEvents(teamId, 0, 2)).toEqual([first, second]);
  expect(replayTeamEvents(teamId, 2, 2)).toEqual([]);
  expect(replayTeamEvents(teamId, 3, 2)).toBeUndefined();
});

test("expired cursors require a snapshot while retained history remains replayable", () => {
  const teamId = crypto.randomUUID();
  onTestFinished(() => releaseTeamEvents(teamId));
  for (let revision = 1; revision <= 501; revision++) publishTeamEvent(teamId, update(revision));
  expect(replayTeamEvents(teamId, 0, 501)).toBeUndefined();
  expect(replayTeamEvents(teamId, 1, 501)).toHaveLength(500);
});
