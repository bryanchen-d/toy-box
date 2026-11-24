import { describe, expect, test } from "bun:test";
import { isTeamTaskWorkingNow, teamAgentPresence } from "./presence";

const working = { status: { state: "working", text: "Re-running perf gates" } } as const;
const waiting = {
  status: { state: "waiting", text: "Your feedback on HTTPS", wakeAt: "2026-10-03T22:00:00.000Z" },
} as const;

describe("team agent presence", () => {
  test("a running agent is working, with the status it set", () => {
    expect(teamAgentPresence(working, true)).toEqual({
      state: "working",
      text: "Re-running perf gates",
    });
    expect(teamAgentPresence({}, true)).toEqual({ state: "working" });
  });

  test("an idle agent can still be waiting", () => {
    expect(teamAgentPresence(waiting, false)).toEqual({
      state: "waiting",
      text: "Your feedback on HTTPS",
      wakeAt: "2026-10-03T22:00:00.000Z",
    });
  });

  test("a working status without a running session is idle", () => {
    expect(teamAgentPresence(working, false)).toEqual({ state: "idle" });
    expect(teamAgentPresence({}, false)).toEqual({ state: "idle" });
  });

  test("running takes precedence over a waiting status", () => {
    expect(teamAgentPresence(waiting, true)).toEqual({ state: "working" });
  });

  test("a running turn works on the tasks it was woken for, which its assignee is working on now", () => {
    const presence = { builder: teamAgentPresence({ turnTasks: ["t1"] }, true) };
    expect(presence.builder).toEqual({ state: "working", tasks: ["t1"] });
    expect(teamAgentPresence({ turnTasks: ["t1"] }, false)).toEqual({ state: "idle" });
    expect(isTeamTaskWorkingNow({ id: "t1", assigneeId: "builder" }, presence)).toBe(true);
    expect(isTeamTaskWorkingNow({ id: "t2", assigneeId: "builder" }, presence)).toBe(false);
    expect(isTeamTaskWorkingNow({ id: "t1" }, presence)).toBe(false);
    expect(
      isTeamTaskWorkingNow({ id: "t1", assigneeId: "builder" }, { builder: { state: "idle" } }),
    ).toBe(false);
  });
});
