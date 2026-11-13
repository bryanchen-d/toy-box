import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "./index";
import {
  createSessionActivity,
  observeActivity,
  sumActivityHours,
  type ActivityHour,
  type SessionActivity,
} from "./activity";

const MINUTE = 60_000;
const thinking: SessionEvent = { type: "status", status: "thinking" };
const background: SessionEvent = { type: "status", status: "background" };
const idle: SessionEvent = { type: "status", status: "idle" };
const end: SessionEvent = { type: "end", reason: "idle" };

function delta(aiCredits: number, tokens?: Extract<SessionEvent, { mode: "delta" }>["tokens"]) {
  return {
    type: "usage",
    mode: "delta",
    usage: { aiCredits, status: "complete" },
    ...(tokens ? { tokens } : {}),
  } satisfies SessionEvent;
}

function total(aiCredits: number): SessionEvent {
  return { type: "usage", mode: "total", usage: { aiCredits, status: "complete" } };
}

/** Observe timestamped events in order, collecting every report. */
function observe(
  events: [time: string, event: SessionEvent][],
  initial: SessionActivity = createSessionActivity(),
) {
  let activity = initial;
  const reports: ActivityHour[][] = [];
  for (const [time, event] of events) {
    const observed = observeActivity(activity, event, Date.parse(time));
    activity = observed.activity;
    reports.push(observed.hours);
  }
  return { activity, reports, hours: sumActivityHours(reports.flat()) };
}

function hour(time: string, counts: Partial<Omit<ActivityHour, "hour">>): ActivityHour {
  return {
    hour: new Date(time).toISOString(),
    turns: 0,
    busyMs: 0,
    aiCredits: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...counts,
  };
}

describe("turns and busy time", () => {
  test("a turn counts where it starts and is busy until the session is ready again", () => {
    const { reports, hours, activity } = observe([
      ["2026-11-12T10:15:00Z", thinking],
      ["2026-11-12T10:45:00Z", background],
    ]);
    expect(reports).toEqual([
      [hour("2026-11-12T10:00:00Z", { turns: 1 })],
      [hour("2026-11-12T10:00:00Z", { busyMs: 30 * MINUTE })],
    ]);
    expect(hours).toEqual([hour("2026-11-12T10:00:00Z", { turns: 1, busyMs: 30 * MINUTE })]);
    expect(activity).toEqual(createSessionActivity());
  });

  test("busy time splits across the UTC hours it spans and the turn counts once", () => {
    expect(
      observe([
        ["2026-11-12T21:50:00Z", thinking],
        ["2026-11-12T23:10:00Z", end],
      ]).hours,
    ).toEqual([
      hour("2026-11-12T21:00:00Z", { turns: 1, busyMs: 10 * MINUTE }),
      hour("2026-11-12T22:00:00Z", { busyMs: 60 * MINUTE }),
      hour("2026-11-12T23:00:00Z", { busyMs: 10 * MINUTE }),
    ]);
  });

  test("status changes within a turn neither start another turn nor restart its busy time", () => {
    const { reports, hours } = observe([
      ["2026-11-12T10:00:00Z", thinking],
      ["2026-11-12T10:05:00Z", { type: "status", status: "reasoning" }],
      ["2026-11-12T10:10:00Z", { type: "status", status: "compacting" }],
      ["2026-11-12T10:15:00Z", { type: "status", status: "responding" }],
      ["2026-11-12T10:16:00Z", thinking],
      ["2026-11-12T10:20:00Z", idle],
    ]);
    expect(reports.slice(1, 5)).toEqual([[], [], [], []]);
    expect(hours).toEqual([hour("2026-11-12T10:00:00Z", { turns: 1, busyMs: 20 * MINUTE })]);
  });

  test("each return to work after being ready starts another turn", () => {
    expect(
      observe([
        ["2026-11-12T10:00:00Z", thinking],
        ["2026-11-12T10:10:00Z", background],
        ["2026-11-12T10:30:00Z", thinking],
        ["2026-11-12T10:40:00Z", end],
      ]).hours,
    ).toEqual([hour("2026-11-12T10:00:00Z", { turns: 2, busyMs: 20 * MINUTE })]);
  });

  test("ready, end, and unrelated events reveal nothing while the session is ready", () => {
    const initial = createSessionActivity(3);
    for (const event of [idle, background, end, { type: "delta", content: "hi" } as const]) {
      expect(observeActivity(initial, event, Date.parse("2026-11-12T10:00:00Z"))).toEqual({
        activity: initial,
        hours: [],
      });
    }
  });
});

describe("credits and tokens", () => {
  test("a receipt adds its credits and tokens to the hour it was reported", () => {
    expect(
      observe([
        [
          "2026-11-12T10:59:00Z",
          delta(0.5, { input: 100, output: 20, cacheRead: 80, cacheWrite: 5 }),
        ],
        [
          "2026-11-12T11:01:00Z",
          delta(0.25, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }),
        ],
        ["2026-11-12T11:02:00Z", delta(0.25)],
      ]).hours,
    ).toEqual([
      hour("2026-11-12T10:00:00Z", {
        aiCredits: 0.5,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheWriteTokens: 5,
      }),
      hour("2026-11-12T11:00:00Z", { aiCredits: 0.5, inputTokens: 10, outputTokens: 2 }),
    ]);
  });

  test("a cumulative total reports only its increase over credits already observed", () => {
    const { reports, activity } = observe(
      [
        ["2026-11-12T10:00:00Z", total(2)],
        ["2026-11-12T10:01:00Z", delta(1)],
        ["2026-11-12T10:02:00Z", total(3.5)],
        ["2026-11-12T10:03:00Z", total(3)],
        ["2026-11-12T10:04:00Z", total(4)],
      ],
      createSessionActivity(2),
    );
    expect(reports.map((report) => report.map(({ aiCredits }) => aiCredits))).toEqual([
      [],
      [1],
      [0.5],
      [],
      [0.5],
    ]);
    expect(activity).toEqual(createSessionActivity(4));
  });

  test("a report without credits or tokens reveals nothing", () => {
    const unavailable: SessionEvent = {
      type: "usage",
      mode: "delta",
      usage: { aiCredits: 0, status: "unavailable" },
    };
    expect(observe([["2026-11-12T10:00:00Z", unavailable]]).hours).toEqual([]);
  });

  test("a report during a turn includes its busy time so far without starting another turn", () => {
    const { reports, hours, activity } = observe([
      ["2026-11-12T10:00:00Z", thinking],
      ["2026-11-12T10:10:00Z", delta(1)],
      ["2026-11-12T10:30:00Z", background],
    ]);
    expect(reports[1]).toEqual([
      hour("2026-11-12T10:00:00Z", { busyMs: 10 * MINUTE, aiCredits: 1 }),
    ]);
    expect(reports[2]).toEqual([hour("2026-11-12T10:00:00Z", { busyMs: 20 * MINUTE })]);
    expect(hours).toEqual([
      hour("2026-11-12T10:00:00Z", { turns: 1, busyMs: 30 * MINUTE, aiCredits: 1 }),
    ]);
    expect(activity).toEqual(createSessionActivity(1));
  });
});

test("summing combines reports for the same hour and orders hours", () => {
  expect(
    sumActivityHours([
      hour("2026-11-12T11:00:00Z", { turns: 1 }),
      hour("2026-11-12T10:00:00Z", { busyMs: 5 }),
      hour("2026-11-12T11:00:00Z", { aiCredits: 0.5, outputTokens: 3 }),
    ]),
  ).toEqual([
    hour("2026-11-12T10:00:00Z", { busyMs: 5 }),
    hour("2026-11-12T11:00:00Z", { turns: 1, aiCredits: 0.5, outputTokens: 3 }),
  ]);
});
