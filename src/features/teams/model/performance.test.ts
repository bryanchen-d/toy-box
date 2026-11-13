import { describe, expect, test } from "bun:test";
import { teamLead, type TeamMember, type TeamMessage } from "./index";
import {
  aggregate,
  bucketStart,
  EMPTY_RUNTIME,
  performanceWindow,
  projectTeamPerformance,
  USER_AUTHOR,
  type TeamWake,
} from "./performance";

const lead = teamLead("lead");
const members: TeamMember[] = [
  { teamId: "lead", id: "builder", name: "Builder" },
  { teamId: "lead", id: "critic", name: "Critic" },
];

/** A local wall-clock time on one day, so buckets hold in any time zone. */
function at(hours: number, minutes = 0): Date {
  return new Date(2026, 10, 12, hours, minutes);
}

let sequence = 0;
function message(
  time: Date,
  content: string,
  sender: TeamMessage["sender"] = { type: "user" },
): TeamMessage {
  sequence += 1;
  return {
    id: `m${sequence}`,
    sequence,
    timestamp: time.toISOString(),
    sender,
    content,
  } as TeamMessage;
}

const agent = (agentId: string) => ({ type: "agent", agentId }) as const;

function project(
  messages: TeamMessage[],
  activity = [] as Parameters<typeof projectTeamPerformance>[1]["activity"],
  wakes: TeamWake[] = [],
) {
  return projectTeamPerformance(messages, {
    lead,
    members,
    bucket: "hour",
    starts: [at(9), at(10), at(11)],
    activity,
    wakes,
  });
}

describe("team performance", () => {
  test("counts each author's messages and each agent's wakes in the hour they happen", () => {
    const performance = project([
      message(at(9, 5), "Please plan the release"),
      message(at(9, 20), "@builder take the build", agent("lead")),
      message(at(10, 10), "Build is green", agent("builder")),
    ]);
    expect(performance.series.map(({ messages, wakes }) => ({ messages, wakes }))).toEqual([
      { messages: { [USER_AUTHOR]: 1, lead: 1 }, wakes: { lead: 1, builder: 1 } },
      { messages: { builder: 1 }, wakes: { lead: 1 } },
      { messages: {}, wakes: {} },
    ]);
    expect(performance.addresses.map(({ from, to, count }) => ({ from, to, count }))).toEqual([
      { from: "builder", to: "lead", count: 1 },
      { from: "lead", to: "builder", count: 1 },
      { from: USER_AUTHOR, to: "lead", count: 1 },
    ]);
  });

  test("measures from each wake to the agent's next public message, leaving unanswered wakes open", () => {
    const performance = project([
      message(at(9), "@builder first"),
      message(at(9, 10), "@builder second"),
      message(at(9, 30), "On it", agent("builder")),
      message(at(10), "@critic review"),
      message(at(10, 1), "@builder third"),
    ]);
    const builder = performance.agents.find(({ agentId }) => agentId === "builder")!;
    expect(builder).toMatchObject({ messages: 1, wakes: 3, answered: 2 });
    expect(builder.medianResponseMs).toBe(20 * 60_000);
    expect(builder.p90ResponseMs).toBe(30 * 60_000);
    expect(performance.agents.find(({ agentId }) => agentId === "critic")).toMatchObject({
      wakes: 1,
      answered: 0,
      medianResponseMs: null,
    });
  });

  test("reply times belong to the bucket of the wake and to the pair that caused it", () => {
    const performance = project([
      message(at(9, 50), "@builder take it", agent("lead")),
      message(at(10, 0), "@builder and this too"),
      message(at(10, 20), "Done", agent("builder")),
    ]);
    expect(performance.series[0]!.responses).toEqual({ builder: [30 * 60_000] });
    expect(performance.series[1]!.responses).toEqual({ builder: [20 * 60_000] });
    const pair = (from: string) =>
      performance.addresses.find((address) => address.from === from && address.to === "builder");
    expect(pair("lead")).toMatchObject({ count: 1, medianResponseMs: 30 * 60_000 });
    expect(pair(USER_AUTHOR)).toMatchObject({ count: 1, medianResponseMs: 20 * 60_000 });
  });

  test("recorded wakes count how each was delivered, per bucket, agent, and pair", () => {
    const wake = (minute: number, delivery: TeamWake["delivery"], author?: string) => ({
      agentId: "builder",
      at: at(9, minute).toISOString(),
      cause: author ? ("message" as const) : ("routine" as const),
      ...(author ? { author } : {}),
      delivery,
    });
    const performance = project([], undefined, [
      wake(1, "started", "lead"),
      wake(2, "steered", "lead"),
      wake(3, "steered", USER_AUTHOR),
      wake(4, "queued"),
    ]);
    expect(performance.series[0]!.deliveries.builder).toEqual({
      started: 1,
      steered: 2,
      queued: 1,
    });
    expect(performance.agents.find(({ agentId }) => agentId === "builder")?.deliveries).toEqual({
      started: 1,
      steered: 2,
      queued: 1,
    });
    expect(
      performance.addresses.map(({ from, to, count, deliveries }) => ({
        from,
        to,
        count,
        deliveries,
      })),
    ).toEqual([
      { from: "lead", to: "builder", count: 0, deliveries: { started: 1, steered: 1, queued: 0 } },
      {
        from: USER_AUTHOR,
        to: "builder",
        count: 0,
        deliveries: { started: 0, steered: 1, queued: 0 },
      },
    ]);
  });

  test("another team and connectors count as authors that wake the lead", () => {
    const performance = project([
      message(at(9), "@health check 727", { type: "team", teamId: "build", by: "lead" }),
      message(at(9, 1), "Posted in #build", { type: "connector", connectorId: "bot" }),
    ]);
    expect(performance.series[0]!.messages).toEqual({ build: 1, bot: 1 });
    expect(performance.series[0]!.wakes).toEqual({ lead: 2 });
  });

  test("ignores messages outside the window and system messages", () => {
    const performance = project([
      message(at(8, 59), "@builder too early"),
      {
        id: "joined",
        sequence: 99,
        timestamp: at(9).toISOString(),
        sender: { type: "system" },
        content: { type: "tasks_completed" },
      },
    ]);
    expect(performance.agents.every(({ wakes, messages }) => wakes + messages === 0)).toBe(true);
  });

  test("adds runtime activity to its bucket and agent, including agents who have since left", () => {
    const hour = { ...EMPTY_RUNTIME, turns: 2, busyMs: 60_000, aiCredits: 1.5, inputTokens: 10 };
    const performance = project(
      [],
      [
        { sessionId: "builder", hour: at(10).toISOString(), ...hour },
        { sessionId: "builder", hour: at(10, 30).toISOString(), ...hour },
        { sessionId: "former", hour: at(11).toISOString(), ...hour },
        { sessionId: "builder", hour: at(12).toISOString(), ...hour },
      ],
    );
    expect(performance.series[1]!.runtime.builder).toEqual({
      ...EMPTY_RUNTIME,
      turns: 4,
      busyMs: 120_000,
      aiCredits: 3,
      inputTokens: 20,
    });
    expect(performance.agents.find(({ agentId }) => agentId === "former")?.runtime.turns).toBe(2);
    expect(performance.agents.find(({ agentId }) => agentId === "builder")?.runtime.turns).toBe(4);
  });
});

describe("aggregations", () => {
  test("percentiles use the nearest rank; an empty sample has no value", () => {
    const values = [40, 10, 30, 20, 100];
    expect(aggregate(values, "p50")).toBe(30);
    expect(aggregate(values, "p90")).toBe(100);
    expect(aggregate(values, "mean")).toBe(40);
    expect(aggregate(values, "max")).toBe(100);
    expect(aggregate([], "p50")).toBeNull();
  });
});

describe("performance windows", () => {
  test("weeks start on Monday and days at local midnight", () => {
    const thursday = new Date(2026, 10, 12, 15, 42);
    expect(bucketStart(thursday, "day")).toEqual(new Date(2026, 10, 12));
    expect(bucketStart(thursday, "week")).toEqual(new Date(2026, 10, 9));
  });

  test("each granularity covers its count of buckets, oldest first, ending now", () => {
    const now = new Date(2026, 10, 12, 15, 42);
    const hours = performanceWindow(now, "hour");
    expect(hours).toHaveLength(24);
    expect(hours.at(-1)).toEqual(new Date(2026, 10, 12, 15));
    expect(hours[0]).toEqual(new Date(2026, 10, 11, 16));
    expect(performanceWindow(now, "day")).toHaveLength(14);
    expect(performanceWindow(now, "week").at(0)).toEqual(new Date(2026, 7, 24));
  });
});
